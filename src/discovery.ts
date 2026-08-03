import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AnalysisOptions } from "./model.js";
import { portablePath } from "./paths.js";

export interface ProjectFiles {
  root: string;
  sourceRoots: string[];
  apex: string[];
  metadata: string[];
}

const APEX_GLOBS = ["**/*.cls", "**/*.trigger"];
const METADATA_GLOBS = [
  "**/*.page",
  "**/*.component",
  "**/*.cmp",
  "**/*.app",
  "**/*.flow-meta.xml",
  "**/*.flow",
  "**/*.md-meta.xml",
  "**/*.js",
];
const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.sf/**",
  "**/.sfdx/**",
  "**/dist/**",
  "**/coverage/**",
  "**/validation/**",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/*.test.js",
  "**/*.spec.js",
];

interface SfdxProject {
  packageDirectories?: Array<{ path?: string }>;
}

export async function discoverProject(projectPath: string, options: AnalysisOptions = {}): Promise<ProjectFiles> {
  const root = path.resolve(projectPath);
  const sourceRoots = await readSourceRoots(root);
  const ignore = [...DEFAULT_IGNORES, ...(options.exclude ?? [])];
  const roots = sourceRoots.length > 0 ? sourceRoots : [root];
  const apex = await findFiles(root, roots, options.include ?? APEX_GLOBS, ignore);
  const metadata = await findFiles(root, roots, METADATA_GLOBS, ignore);
  return { root, sourceRoots: roots.map((value) => portablePath(path.relative(root, value) || ".")), apex, metadata };
}

async function readSourceRoots(root: string): Promise<string[]> {
  try {
    const raw = await readFile(path.join(root, "sfdx-project.json"), "utf8");
    const project = JSON.parse(raw) as SfdxProject;
    return (project.packageDirectories ?? [])
      .map((entry) => entry.path)
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(root, value));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new Error(`Unable to read sfdx-project.json: ${errorMessage(error)}`);
  }
}

async function findFiles(root: string, roots: string[], patterns: string[], ignore: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const sourceRoot of roots) {
    const matches = await fg(patterns, {
      cwd: sourceRoot,
      absolute: true,
      onlyFiles: true,
      unique: true,
      ignore,
      followSymbolicLinks: false,
    });
    for (const match of matches) {
      const absolute = path.resolve(match);
      if (isWithin(root, absolute)) files.add(absolute);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
