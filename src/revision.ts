import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositoryRevision } from "./model.js";

const execFileAsync = promisify(execFile);

export async function readRepositoryRevision(root: string): Promise<RepositoryRevision> {
  try {
    const [branch, commit, status] = await Promise.all([
      git(root, ["branch", "--show-current"]),
      git(root, ["rev-parse", "HEAD"]),
      git(root, ["status", "--porcelain"]),
    ]);
    return {
      available: true,
      branch: branch || "detached-head",
      commit,
      dirty: status.length > 0,
    };
  } catch {
    return { available: false };
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}
