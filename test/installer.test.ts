import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_VERSION } from "../src/version.js";

describe("Windows installer", () => {
  it("uses a user-local npm shim without inline PowerShell PATH editing", async () => {
    const [installer, packageSource, cli] = await Promise.all([
      readFile(path.resolve("install.bat"), "utf8"),
      readFile(path.resolve("package.json"), "utf8"),
      readFile(path.resolve("src/cli.ts"), "utf8"),
    ]);

    expect(installer).toContain('set "SHIM_DIR=%APPDATA%\\npm"');
    expect(installer).toContain("APEX_REACH_SHIM_DIR");
    expect(installer.toLowerCase()).not.toContain("powershell");
    expect(installer).not.toContain("SetEnvironmentVariable");
    expect(JSON.parse(packageSource).version).toBe(TOOL_VERSION);
    expect(cli).toContain(".version(TOOL_VERSION)");
  });
});
