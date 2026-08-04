import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analyze.js";

const fixture = path.resolve("fixtures/quality");

describe("quality recovery analysis", () => {
  it("detects parameterized and near-miss clones without counting test code", async () => {
    const report = await analyzeProject(fixture);
    const parameterized = report.duplicates.cloneGroups.find((group) =>
      group.kind === "parameterized"
      && group.occurrences.some((item) => item.symbolId.includes("duplicatealpha.calculate"))
      && group.occurrences.some((item) => item.symbolId.includes("duplicatebeta.compute")),
    );
    const nearMiss = report.duplicates.cloneGroups.find((group) =>
      group.kind === "near-miss"
      && group.occurrences.some((item) => item.symbolId.includes("duplicategamma.summarize")),
    );
    const exact = report.duplicates.cloneGroups.find((group) => group.kind === "exact"
      && group.occurrences.some((item) => item.symbolId.includes("exactone.transform"))
      && group.occurrences.some((item) => item.symbolId.includes("exacttwo.transform")));

    expect(exact).toBeDefined();
    expect(parameterized).toBeDefined();
    expect(nearMiss).toBeDefined();
    expect(report.duplicates.duplicatedCharacters).toBeGreaterThan(0);
    expect(report.duplicates.coverage.status).toBe("complete");
    expect(report.duplicates.cloneGroups.every((group) => group.occurrences.every((item) => !item.symbolId.includes("qualitytest")))).toBe(true);
  });

  it("groups SOQL selector and DML domain opportunities", async () => {
    const report = await analyzeProject(fixture);
    const accountFamily = report.duplicates.queryFamilies.find((family) => family.object.toLowerCase() === "account");
    const contactInsert = report.duplicates.dmlFamilies.find((family) =>
      family.operation === "insert" && family.targetType.toLowerCase() === "contact",
    );

    expect(accountFamily?.kind).toBe("selector-family");
    expect(accountFamily?.occurrences).toHaveLength(2);
    expect(contactInsert?.occurrences).toHaveLength(2);
    expect(report.duplicates.dmlFamilies.find((family) => family.operation === "insert" && family.targetType.toLowerCase() === "account")?.occurrences).toHaveLength(2);
    expect(accountFamily?.occurrences.every((item) => item.securityMode === "unspecified")).toBe(true);
    expect(report.duplicates.queryCoverage.status).toBe("blocked");
    expect(report.duplicates.queryCoverage.unresolvedDynamicQueries.some((gap) => gap.symbolId.includes("dynamicqueries.unknown"))).toBe(true);
  });

  it("classifies simple trigger paths separately from unsupported callouts", async () => {
    const report = await analyzeProject(fixture);
    const byName = new Map(report.flowMigration.assessments.map((assessment) => [assessment.triggerName, assessment]));

    expect(byName.get("SimpleAccountTrigger")?.status).toBe("eligible");
    expect(byName.get("SimpleAccountTrigger")?.kind).toBe("before-save-field-update");
    expect(byName.get("SimpleOpportunityTrigger")?.status).toBe("eligible");
    expect(byName.get("SimpleOpportunityTrigger")?.kind).toBe("after-save-record-action");
    expect(byName.get("SimpleOpportunityTrigger")?.reclaimableArtifacts.map((item) => item.action)).toEqual(["delete-file", "delete-file"]);
    expect(byName.get("BlockedAccountTrigger")?.status).toBe("ineligible");
    expect(byName.get("BlockedAccountTrigger")?.blockers.join(" ")).toMatch(/callout/i);
    expect(byName.get("BlockedAccountTrigger")?.blockers.join(" ")).not.toMatch(/recursive|cyclic/i);
    expect(byName.get("BlockedAccountTrigger")?.blockers.join(" ")).toMatch(/existing flow automation/i);
    expect(byName.get("LocalOnlyTrigger")?.status).toBe("ineligible");
    expect(byName.get("LocalOnlyTrigger")?.blockers.join(" ")).toMatch(/not proven to target Trigger\.new/i);
    expect(report.flowMigration.reclaimableCharacters).toBeGreaterThan(0);
  });

  it("records the analyzed git revision when available", async () => {
    const report = await analyzeProject(fixture);
    expect(report.revision.available).toBe(true);
    expect(report.revision.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
