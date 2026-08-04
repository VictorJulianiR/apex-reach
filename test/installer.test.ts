import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows installer", () => {
  it("uses a user-local npm shim without inline PowerShell PATH editing", async () => {
    const installer = await readFile(path.resolve("install.bat"), "utf8");

    expect(installer).toContain('set "SHIM_DIR=%APPDATA%\\npm"');
    expect(installer).toContain("APEX_REACH_SHIM_DIR");
    expect(installer.toLowerCase()).not.toContain("powershell");
    expect(installer).not.toContain("SetEnvironmentVariable");
  });
});
