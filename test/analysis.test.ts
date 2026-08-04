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
    expect(report.reachability[byName.get("AccountHandler.dispatch(Integer)")!.id]).toBe("production");
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

  it("keeps repository-unreachable candidates deterministic despite exposure and dynamic blockers", async () => {
    const report = await analyzeProject(fixture);
    const privateCandidate = report.candidates.find((candidate) => candidate.qualifiedName === "UnusedPrivate")!;
    const publicCandidate = report.candidates.find((candidate) => candidate.qualifiedName === "UnusedPublic")!;

    expect(privateCandidate.classification).toBe("unreachable-in-repository");
    expect(publicCandidate.classification).toBe("unreachable-in-repository");
    expect("confidence" in privateCandidate).toBe(false);
    expect("confidence" in publicCandidate).toBe(false);
    expect(report.analysis.blockers.some((blocker) => blocker.code === "dynamic-type")).toBe(true);
    expect(report.analysis.blockers.some((blocker) => blocker.symbolId?.includes("deaddynamic"))).toBe(false);
    expect(report.analysis.status).toBe("blocked");
  });

  it("blocks the conclusion for a computed type lookup on a production path", async () => {
    const report = await analyzeProject(path.resolve("fixtures/dynamic-live"));
    const blocker = report.analysis.blockers.find((item) => item.code === "dynamic-type")!;

    expect(report.analysis.status).toBe("blocked");
    expect(blocker.symbolId).toContain("dynamiclookup.touch");
    expect(blocker.location?.path).toContain("DynamicLookup.cls");
  });

  it("does not treat callable annotations as proof of a production call", async () => {
    const report = await analyzeProject(fixture);
    const type = report.symbols.find((symbol) => symbol.qualifiedName === "ExposedOnly")!;
    const auraMethod = report.symbols.find((symbol) => symbol.qualifiedName === "ExposedOnly.auraMethod()")!;
    const flowMethod = report.symbols.find((symbol) => symbol.qualifiedName.startsWith("ExposedOnly.flowMethod("))!;

    expect(report.reachability[type.id]).toBe("unreachable");
    expect(report.reachability[auraMethod.id]).toBe("unreachable");
    expect(report.reachability[flowMethod.id]).toBe("unreachable");
    expect(report.candidates.some((candidate) => candidate.symbolId === type.id)).toBe(true);
  });

  it("does not turn a class name inside metadata prose into a production call", async () => {
    const report = await analyzeProject(fixture);
    const type = report.symbols.find((symbol) => symbol.qualifiedName === "UnusedPublic")!;

    expect(report.reachability[type.id]).toBe("unreachable");
  });

  it("resolves Aura bundle controller methods but leaves uncalled methods unreachable", async () => {
    const report = await analyzeProject(fixture);
    const invoked = report.symbols.find((symbol) => symbol.qualifiedName === "AuraController.invoked()")!;
    const orphan = report.symbols.find((symbol) => symbol.qualifiedName === "AuraController.orphan()")!;

    expect(report.reachability[invoked.id]).toBe("production");
    expect(report.reachability[orphan.id]).toBe("unreachable");
  });

  it("conservatively follows interface dispatch and constructed platform callbacks", async () => {
    const report = await analyzeProject(fixture);
    const implementation = report.symbols.find((symbol) => symbol.qualifiedName === "WorkerImpl.run()")!;
    const queueExecute = report.symbols.find((symbol) => symbol.qualifiedName.startsWith("QueueJob.execute("))!;

    expect(report.reachability[implementation.id]).toBe("production");
    expect(report.reachability[queueExecute.id]).toBe("production");
  });

  it("excludes test source from the production footprint and renders a useful report", async () => {
    const report = await analyzeProject(fixture);
    expect(report.inventory.testApexCharacters).toBeGreaterThan(0);
    expect(report.inventory.productionApexCharacters).toBeGreaterThan(report.inventory.testApexCharacters);
    expect(report.candidates.every((candidate) => !candidate.qualifiedName.startsWith("LegacyTest"))).toBe(true);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain("# Apex capacity recovery analysis");
    expect(markdown).toContain("## Leadership view");
    expect(markdown).toContain("Safe deprecation");
    expect(report.executive.deprecationCandidatePercent).toBeGreaterThan(0);
    expect(report.executive.retainedPercent + report.executive.deprecationCandidatePercent).toBe(100);
    expect(report.executive.redundancy.status).toBe("measured");
    expect(markdown).toContain("UnusedPrivate");
    expect(markdown).toContain("Deterministic closed-world result");
    expect(markdown).toContain("Duplicate clone families");
    expect(markdown).toContain("Trigger-to-Flow conversion");
    expect(markdown).not.toMatch(/\b(high|medium|low)[ -]confidence\b/i);
  });
});
