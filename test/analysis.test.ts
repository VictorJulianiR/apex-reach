import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractApexFile } from "../src/apex/extract.js";
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

  it("keeps parser diagnostics in test-only source out of production certification", async () => {
    const report = await analyzeProject(path.resolve("fixtures/test-parse-error"));

    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]?.path).toContain("BrokenSyntaxTest.cls");
    expect(report.analysis.blockers.some((item) => item.code === "parse-error")).toBe(false);
    expect(report.analysis.status).toBe("complete");
  });

  it("continues to block when a parser diagnostic can hide production calls", async () => {
    const report = await analyzeProject(path.resolve("fixtures/production-parse-error"));

    expect(report.analysis.blockers.some((item) => item.code === "parse-error")).toBe(true);
    expect(report.analysis.findings).toHaveLength(0);
    expect(report.analysis.status).toBe("blocked");
  });

  it("keeps a conditional runtime override blocked even when the default comes from Custom Metadata", async () => {
    const report = await analyzeProject(path.resolve("fixtures/conditional-dynamic-type"));
    const blocker = report.analysis.blockers.find((item) => item.code === "dynamic-type")!;

    expect(report.analysis.status).toBe("blocked");
    expect(blocker.symbolId).toContain("conditionalresolver.run");
    expect(blocker.dynamicExpression).toBe("className");
    expect(blocker.dynamicReasons?.some((reason) => reason.includes("RootTrigger")
      && reason.includes("String.valueOf(Trigger.operationType)"))).toBe(true);
    expect(blocker.message).toContain("Unresolved provenance");
  });

  it("resolves a computed type lookup from repository Custom Metadata values", async () => {
    const report = await analyzeProject(path.resolve("fixtures/metadata-dynamic-type"), { fullGraph: true });
    const configured = report.symbols.find((symbol) => symbol.qualifiedName === "ConfiguredService")!;
    const instantiate = report.symbols.find((symbol) => symbol.qualifiedName === "MetadataTypeResolver.instantiate(String)")!;

    expect(report.analysis.blockers.some((item) => item.code === "dynamic-type")).toBe(false);
    expect(report.reachability[configured.id]).toBe("production");
    expect(report.analysis.status).toBe("complete");
    expect(report.symbols.filter((symbol) => symbol.qualifiedName.startsWith("MetadataTypeResolver.run")
      && report.reachability[symbol.id] === "production")).toHaveLength(6);
    expect(report.references.some((reference) => reference.sourceId === instantiate.id
      && reference.targetId === configured.id
      && reference.detail.includes("Resolved Type.forName value"))).toBe(true);

    const classPath = path.resolve("fixtures/metadata-dynamic-type/force-app/main/default/classes/MetadataTypeResolver.cls");
    const extracted = await extractApexFile(classPath, "force-app/main/default/classes/MetadataTypeResolver.cls");
    const injected = extracted.blockers.find((item) => item.symbolId?.includes("runinjectedservice"));
    expect(injected?.repositoryMetadataField).toBeUndefined();
  });

  it("analyzes duplicate declarations conservatively without blocking unrelated certification", async () => {
    const report = await analyzeProject(path.resolve("fixtures/duplicate-components"));
    const blockerCodes: string[] = report.analysis.blockers.map((item) => item.code);
    const findings = report.analysis.findings.filter((item) => item.code === "duplicate-symbol");
    const duplicateClasses = report.symbols.filter((symbol) => symbol.qualifiedName === "ApprovalProcessHandler");
    const duplicateMethods = report.symbols.filter((symbol) => symbol.qualifiedName === "ApprovalProcessHandler.start()");

    expect(blockerCodes).not.toContain("duplicate-symbol");
    expect(findings).toHaveLength(2);
    expect(findings.some((item) => item.message.includes("ApprovalProcessHandler"))).toBe(true);
    expect(findings.some((item) => item.message.includes("ContractTrigger"))).toBe(true);
    expect(report.analysis.status).toBe("complete");
    expect(new Set(duplicateClasses.map((symbol) => symbol.id)).size).toBe(2);
    expect(new Set(duplicateMethods.map((symbol) => symbol.id)).size).toBe(2);
    expect(duplicateMethods.every((symbol) => report.reachability[symbol.id] === "production")).toBe(true);

    const markdown = renderMarkdown(report);
    expect(markdown).not.toContain("## Why certification is blocked");
    expect(markdown).toContain("## Repository integrity findings");
    expect(markdown).toContain("package-a/main/default/classes/ApprovalProcessHandler.cls");
    expect(markdown).toContain("package-b/main/default/classes/ApprovalProcessHandler.cls");
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
    expect(markdown).toContain("Deprecation candidates - not certified");
    expect(markdown).toContain("## Why certification is blocked");
    expect(markdown).not.toContain("Safe deprecation");
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
