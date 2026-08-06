import { stat } from "node:fs/promises";
import path from "node:path";
import { extractApexFile } from "./apex/extract.js";
import { discoverProject } from "./discovery.js";
import { resolveRepositoryDynamicTypes } from "./dynamic-types.js";
import { buildGraph } from "./graph.js";
import { analyzeMetadata } from "./metadata.js";
import { analyzeDuplicates } from "./quality/duplicates.js";
import { analyzeFlowMigration } from "./quality/flow.js";
import { inspectRecordAutomation } from "./quality/automation.js";
import { readRepositoryRevision } from "./revision.js";
import {
  REPORT_SCHEMA_VERSION,
  type AnalysisBlocker,
  type AnalysisOptions,
  type AnalysisReport,
  type ApexSymbol,
  type ExtractedFile,
  type ProjectInventory,
} from "./model.js";
import { relativePath } from "./paths.js";
import { TOOL_VERSION } from "./version.js";

/**
 * Stable external seam for the analyzer. It performs no writes and requires no Salesforce org.
 */
export async function analyzeProject(projectPath: string, options: AnalysisOptions = {}): Promise<AnalysisReport> {
  const root = path.resolve(projectPath);
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) throw new Error(`Project directory does not exist: ${root}`);
  const revisionPromise = readRepositoryRevision(root);

  const files = await discoverProject(root, options);
  const automationPromise = inspectRecordAutomation(root, files.metadata);
  const apexFiles = await mapLimit(files.apex, 8, (absolutePath) =>
    extractApexFile(absolutePath, relativePath(root, absolutePath)),
  );
  const symbols = apexFiles.flatMap((file) => file.symbols);
  const metadata = await analyzeMetadata(
    files.metadata.map((absolutePath) => ({ absolutePath, reportPath: relativePath(root, absolutePath) })),
    symbols,
  );
  const diagnostics = apexFiles.flatMap((file) => file.diagnostics);
  const blockers: AnalysisBlocker[] = [
    ...apexFiles.flatMap((file) => file.blockers),
    ...diagnostics.map((diagnostic): AnalysisBlocker => ({
      code: "parse-error",
      scope: "project",
      message: diagnostic.message,
      blocksClosedWorldConclusion: true,
      location: { path: diagnostic.path, line: diagnostic.line, column: diagnostic.column },
    })),
    ...duplicateSymbolBlockers(symbols),
  ];
  const exposures = apexFiles.flatMap((file) => file.exposures);
  const declaredEntries = apexFiles.flatMap((file) => file.entryPoints);
  const rawReferences = [...apexFiles.flatMap((file) => file.references), ...metadata.references];
  const preliminaryGraph = buildGraph(
    symbols,
    rawReferences,
    declaredEntries,
    blockers,
    exposures,
  );
  const dynamicTypes = resolveRepositoryDynamicTypes({
    blockers,
    files: apexFiles,
    symbols,
    references: preliminaryGraph.references,
    entryPoints: preliminaryGraph.entryPoints,
    reachability: preliminaryGraph.reachability,
    configuredTypeFields: metadata.configuredTypeFields,
  });
  const graph = buildGraph(
    symbols,
    [...rawReferences, ...dynamicTypes.references],
    declaredEntries,
    dynamicTypes.blockers,
    exposures,
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
  const duplicates = analyzeDuplicates(apexFiles, inventory.productionApexCharacters, graph.reachability);
  const flowMigration = analyzeFlowMigration(
    apexFiles,
    symbols,
    graph.references,
    graph.entryPoints,
    inventory.productionApexCharacters,
    await automationPromise,
    graph.blockers,
  );
  const executive = buildExecutiveSummary(
    apexFiles,
    symbols,
    graph.candidates,
    inventory.productionApexCharacters,
    duplicates,
    flowMigration,
  );
  const reportReferences = options.fullGraph
    ? graph.references
    : selectReferenceEvidence(graph.references, graph.reachability, graph.evidencePaths, new Set(graph.candidates.map((candidate) => candidate.symbolId)));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "apex-reach", version: TOOL_VERSION },
    generatedAt: new Date().toISOString(),
    inventory,
    summary,
    executive,
    revision: await revisionPromise,
    duplicates,
    flowMigration,
    analysis: {
      universe: "repository",
      assumption: "All deployable Apex and metadata that define production calls are present in the analyzed SFDX package directories; callers outside the repository are outside this result.",
      status: graph.blockers.some((blocker) => blocker.blocksClosedWorldConclusion) ? "blocked" : "complete",
      blockers: graph.blockers,
    },
    symbols: symbols.sort(compareSymbols),
    references: reportReferences.sort(compareLocations),
    entryPoints: graph.entryPoints.sort(compareLocations),
    reachability: graph.reachability,
    evidencePaths: graph.evidencePaths,
    candidates: graph.candidates,
    exposures: graph.exposures,
    diagnostics,
  };
}

function buildExecutiveSummary(
  files: ExtractedFile[],
  symbols: ApexSymbol[],
  candidates: AnalysisReport["candidates"],
  productionCharacters: number,
  duplicates: AnalysisReport["duplicates"],
  flowMigration: AnalysisReport["flowMigration"],
): AnalysisReport["executive"] {
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const candidateTypeIds = new Set(
    candidates
      .filter((candidate) => candidate.kind === "class" || candidate.kind === "interface" || candidate.kind === "enum")
      .map((candidate) => candidate.symbolId),
  );
  const fileCharacters = new Map(files.map((file) => [file.path, file.characters]));
  const candidateFiles = new Set(
    candidates
      .filter((candidate) => candidateTypeIds.has(candidate.symbolId))
      .map((candidate) => candidate.location.path),
  );
  const topLevelCharacters = [...candidateFiles]
    .reduce((total, filePath) => total + (fileCharacters.get(filePath) ?? 0), 0);
  const internalCandidates = candidates.filter((candidate) => {
    if (candidate.kind !== "method" && candidate.kind !== "constructor") return false;
    let symbol = byId.get(candidate.symbolId);
    while (symbol?.ownerId) {
      if (candidateTypeIds.has(symbol.ownerId)) return false;
      symbol = byId.get(symbol.ownerId);
    }
    return true;
  });
  const memberCharacters = internalCandidates.reduce((total, candidate) => total + candidate.sourceCharacters, 0);
  const deprecationCandidateCharacters = Math.min(productionCharacters, topLevelCharacters + memberCharacters);
  const retainedCharacters = Math.max(0, productionCharacters - deprecationCandidateCharacters);
  return {
    productionCharacters,
    deprecationCandidateCharacters,
    deprecationCandidatePercent: percent(deprecationCandidateCharacters, productionCharacters),
    retainedCharacters,
    retainedPercent: percent(retainedCharacters, productionCharacters),
    topLevelCandidateFiles: candidateFiles.size,
    internalRefactorCandidates: internalCandidates.length,
    redundancy: {
      status: "measured",
      coveredCharacters: duplicates.cloneCoverageCharacters,
      coveredPercent: duplicates.cloneCoverageCharacterPercent,
      duplicatedCharacters: duplicates.duplicatedCharacters,
      duplicatedPercent: duplicates.duplicatedCharacterPercent,
      cloneGroups: duplicates.cloneGroups.length,
      queryFamilies: duplicates.queryFamilies.length,
      reason: "Clone coverage and repeated-occurrence coverage use unique, non-test source intervals from accepted exact, parameterized, and verified near-miss profiles. Query and DML families remain separate, and no clone percentage is labeled guaranteed Apex savings.",
    },
    flowAutomation: {
      eligibleTriggers: flowMigration.eligibleTriggers,
      reclaimableCharacters: flowMigration.reclaimableCharacters,
      reclaimablePercent: flowMigration.reclaimablePercent,
    },
  };
}

function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 10_000) / 100;
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

function duplicateSymbolBlockers(symbols: ApexSymbol[]): AnalysisBlocker[] {
  const grouped = new Map<string, ApexSymbol[]>();
  for (const symbol of symbols) {
    const values = grouped.get(symbol.id);
    if (values) values.push(symbol);
    else grouped.set(symbol.id, [symbol]);
  }
  const duplicateGroups = [...grouped.values()].filter((values) => values.length > 1);
  const duplicatedTopLevelIds = new Set(
    duplicateGroups
      .filter((values) => values.every((symbol) => symbol.ownerId === undefined && isTopLevelType(symbol)))
      .map((values) => values[0]!.id),
  );
  return duplicateGroups
    .filter((values) => {
      const first = values[0]!;
      return duplicatedTopLevelIds.has(first.id) || !first.ownerId || !duplicatedTopLevelIds.has(first.ownerId);
    })
    .map((values) => {
      const first = values[0]!;
      const locations = values.map((value) => `${value.location.path}:${value.location.line}`).join(", ");
      const topLevel = duplicatedTopLevelIds.has(first.id);
      return {
        code: "duplicate-symbol" as const,
        scope: "project" as const,
        message: topLevel
          ? `Duplicate top-level Apex component ${first.qualifiedName} appears at ${locations}. Member collisions are represented by this component-level blocker.`
          : `Duplicate symbol ${first.qualifiedName} appears at ${locations}.`,
        blocksClosedWorldConclusion: true,
        location: first.location,
      };
    });
}

function isTopLevelType(symbol: ApexSymbol): boolean {
  return symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum" || symbol.kind === "trigger";
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
