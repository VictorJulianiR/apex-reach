import { stat } from "node:fs/promises";
import path from "node:path";
import { extractApexFile } from "./apex/extract.js";
import { discoverProject } from "./discovery.js";
import { buildGraph } from "./graph.js";
import { extractMetadataReferences } from "./metadata.js";
import {
  REPORT_SCHEMA_VERSION,
  type AnalysisOptions,
  type AnalysisReport,
  type ApexSymbol,
  type ExtractedFile,
  type ProjectInventory,
  type Uncertainty,
} from "./model.js";
import { relativePath } from "./paths.js";

const TOOL_VERSION = "0.1.0";

/**
 * Stable external seam for the analyzer. It performs no writes and requires no Salesforce org.
 */
export async function analyzeProject(projectPath: string, options: AnalysisOptions = {}): Promise<AnalysisReport> {
  const root = path.resolve(projectPath);
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) throw new Error(`Project directory does not exist: ${root}`);

  const files = await discoverProject(root, options);
  const apexFiles = await mapLimit(files.apex, 8, (absolutePath) =>
    extractApexFile(absolutePath, relativePath(root, absolutePath)),
  );
  const metadataReferences = (await mapLimit(files.metadata, 16, (absolutePath) =>
    extractMetadataReferences(absolutePath, relativePath(root, absolutePath)),
  )).flat();

  const symbols = apexFiles.flatMap((file) => file.symbols);
  const diagnostics = apexFiles.flatMap((file) => file.diagnostics);
  const uncertainties: Uncertainty[] = [
    ...apexFiles.flatMap((file) => file.uncertainties),
    ...diagnostics.map((diagnostic): Uncertainty => ({
      code: "parse-error",
      scope: "project",
      message: diagnostic.message,
      location: { path: diagnostic.path, line: diagnostic.line, column: diagnostic.column },
    })),
    ...duplicateSymbolUncertainties(symbols),
    {
      code: "metadata-gap",
      scope: "project",
      message: "The analysis covers repository files only; org-only metadata, queued jobs, configuration data, and external consumers are not observable offline.",
    },
  ];

  const graph = buildGraph(
    symbols,
    [...apexFiles.flatMap((file) => file.references), ...metadataReferences],
    apexFiles.flatMap((file) => file.entryPoints),
    uncertainties,
  );
  const inventory = buildInventory(root, files.sourceRoots, apexFiles, files.metadata.length);
  const summary = {
    symbols: symbols.length,
    classes: symbols.filter((symbol) => symbol.kind === "class").length,
    methods: symbols.filter((symbol) => symbol.kind === "method" || symbol.kind === "constructor").length,
    entryPoints: graph.entryPoints.length,
    resolvedReferences: graph.references.filter((reference) => reference.resolution !== "unresolved").length,
    unresolvedReferences: graph.references.filter((reference) => reference.resolution === "unresolved").length,
    productionReachable: countReachability(graph.reachability, "production"),
    testOnlyReachable: countReachability(graph.reachability, "test-only"),
    unreachable: countReachability(graph.reachability, "unreachable"),
    candidateClasses: graph.candidates.filter((candidate) => candidate.kind === "class" || candidate.kind === "interface" || candidate.kind === "enum").length,
    candidateMethods: graph.candidates.filter((candidate) => candidate.kind === "method" || candidate.kind === "constructor").length,
    candidateClassCharacters: graph.candidates
      .filter((candidate) => candidate.kind === "class" || candidate.kind === "interface" || candidate.kind === "enum")
      .reduce((total, candidate) => total + candidate.sourceCharacters, 0),
    candidateClassBytes: graph.candidates
      .filter((candidate) => candidate.kind === "class" || candidate.kind === "interface" || candidate.kind === "enum")
      .reduce((total, candidate) => total + candidate.sourceBytes, 0),
  };
  const reportReferences = options.fullGraph
    ? graph.references
    : selectReferenceEvidence(graph.references, graph.reachability, graph.evidencePaths, new Set(graph.candidates.map((candidate) => candidate.symbolId)));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "apex-reach", version: TOOL_VERSION },
    generatedAt: new Date().toISOString(),
    inventory,
    summary,
    symbols: symbols.sort(compareSymbols),
    references: reportReferences.sort(compareLocations),
    entryPoints: graph.entryPoints.sort(compareLocations),
    reachability: graph.reachability,
    evidencePaths: graph.evidencePaths,
    candidates: graph.candidates,
    uncertainties: graph.uncertainties,
    diagnostics,
  };
}

function selectReferenceEvidence(
  references: AnalysisReport["references"],
  reachability: AnalysisReport["reachability"],
  evidencePaths: AnalysisReport["evidencePaths"],
  candidateIds: Set<string>,
): AnalysisReport["references"] {
  const evidencePairs = new Set<string>();
  for (const path of Object.values(evidencePaths)) {
    for (let index = 1; index < path.length; index += 1) {
      evidencePairs.add(`${path[index - 1]}|${path[index]}`);
    }
  }
  return references.filter((reference) => {
    if (reference.resolution === "unresolved" || reference.kind === "metadata") return true;
    if (reference.sourceId && reference.targetId && evidencePairs.has(`${reference.sourceId}|${reference.targetId}`)) return true;
    if (reference.sourceId && candidateIds.has(reference.sourceId)) return true;
    if (reference.targetId && candidateIds.has(reference.targetId)) return true;
    return reference.sourceId !== undefined && reachability[reference.sourceId] === "unreachable";
  });
}

function buildInventory(root: string, sourceRoots: string[], files: ExtractedFile[], metadataFiles: number): ProjectInventory {
  let productionApexCharacters = 0;
  let productionApexBytes = 0;
  let testApexCharacters = 0;
  let testApexBytes = 0;
  for (const file of files) {
    const topLevel = file.symbols.find((symbol) => !symbol.ownerId);
    if (topLevel?.testCode) {
      testApexCharacters += file.characters;
      testApexBytes += file.bytes;
    } else {
      productionApexCharacters += file.characters;
      productionApexBytes += file.bytes;
    }
  }
  return {
    root,
    sourceRoots,
    apexFiles: files.length,
    metadataFiles,
    apexCharacters: productionApexCharacters + testApexCharacters,
    apexBytes: productionApexBytes + testApexBytes,
    productionApexCharacters,
    productionApexBytes,
    testApexCharacters,
    testApexBytes,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) result[index] = await task(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return result;
}

function duplicateSymbolUncertainties(symbols: ApexSymbol[]): Uncertainty[] {
  const grouped = new Map<string, ApexSymbol[]>();
  for (const symbol of symbols) {
    const values = grouped.get(symbol.id);
    if (values) values.push(symbol);
    else grouped.set(symbol.id, [symbol]);
  }
  return [...grouped.values()]
    .filter((values) => values.length > 1)
    .map((values) => ({
      code: "duplicate-symbol" as const,
      scope: "project" as const,
      message: `Duplicate symbol ${values[0]?.qualifiedName ?? "unknown"} appears at ${values.map((value) => `${value.location.path}:${value.location.line}`).join(", ")}.`,
      ...(values[0] ? { location: values[0].location } : {}),
    }));
}

function countReachability(values: Record<string, string>, expected: string): number {
  return Object.values(values).filter((value) => value === expected).length;
}

function compareSymbols(left: ApexSymbol, right: ApexSymbol): number {
  return left.location.path.localeCompare(right.location.path)
    || left.location.line - right.location.line
    || left.qualifiedName.localeCompare(right.qualifiedName);
}

function compareLocations<T extends { location: { path: string; line: number; column: number } }>(left: T, right: T): number {
  return left.location.path.localeCompare(right.location.path)
    || left.location.line - right.location.line
    || left.location.column - right.location.column;
}
