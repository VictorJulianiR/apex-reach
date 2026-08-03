import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analyze.js";
import { renderMarkdown } from "../src/report.js";

const fixture = path.resolve("fixtures/mixed");

describe("analyzeProject", () => {
  it("separates production, test-only, and unreachable symbols", async () => {
    const report = await analyzeProject(fixture);
    const byName = new Map(report.symbols.map((symbol) => [symbol.qualifiedName, symbol]));

    expect(report.reachability[byName.get("AccountTrigger")!.id]).toBe("production");
    expect(report.reachability[byName.get("AccountHandler.run(List<Account>)")!.id]).toBe("production");
    expect(report.reachability[byName.get("AccountHandler.helper(Integer)")!.id]).toBe("production");
    expect(report.reachability[byName.get("AccountHandler.orphan()")!.id]).toBe("unreachable");
    expect(report.reachability[byName.get("Legacy.onlyTestsCallThis()")!.id]).toBe("test-only");
    expect(report.candidates.some((candidate) => candidate.qualifiedName.startsWith("Legacy"))).toBe(false);
  });

  it("uses LWC imports as exact metadata entry points", async () => {
    const report = await analyzeProject(fixture);
    const load = report.symbols.find((symbol) => symbol.qualifiedName === "UiController.load()")!;
    expect(report.reachability[load.id]).toBe("production");
    expect(report.entryPoints.some((entry) => entry.symbolId === load.id && entry.source === "metadata")).toBe(true);
    expect(report.evidencePaths[load.id]).toEqual([load.id]);
  });

  it("recognizes class names stored in Custom Metadata", async () => {
    const report = await analyzeProject(fixture);
    const configured = report.symbols.find((symbol) => symbol.qualifiedName === "ConfiguredOnly")!;
    expect(report.reachability[configured.id]).toBe("production");
    expect(report.entryPoints.some((entry) => entry.symbolId === configured.id && entry.reason.includes("Custom Metadata"))).toBe(true);
  });

  it("grades candidates using external and dynamic uncertainty", async () => {
    const report = await analyzeProject(fixture);
    const privateCandidate = report.candidates.find((candidate) => candidate.qualifiedName === "UnusedPrivate")!;
    const publicCandidate = report.candidates.find((candidate) => candidate.qualifiedName === "UnusedPublic")!;

    expect(privateCandidate.confidence).toBe("medium");
    expect(privateCandidate.uncertainties).toContain("The project contains a computed Type.forName reference.");
    expect(publicCandidate.confidence).toBe("low");
    expect(report.uncertainties.some((uncertainty) => uncertainty.code === "dynamic-type")).toBe(true);
  });

  it("excludes test source from the production footprint and renders a useful report", async () => {
    const report = await analyzeProject(fixture);
    expect(report.inventory.testApexCharacters).toBeGreaterThan(0);
    expect(report.inventory.productionApexCharacters).toBeGreaterThan(report.inventory.testApexCharacters);
    expect(report.candidates.every((candidate) => !candidate.qualifiedName.startsWith("LegacyTest"))).toBe(true);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain("# Apex recovery analysis");
    expect(markdown).toContain("UnusedPrivate");
    expect(markdown).toContain("not a safe-to-delete verdict");
  });
});
