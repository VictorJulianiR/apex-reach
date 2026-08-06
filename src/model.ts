export const REPORT_SCHEMA_VERSION = "3.0.0" as const;

export type SymbolKind = "class" | "interface" | "enum" | "trigger" | "method" | "constructor";
export type Reachability = "production" | "test-only" | "unreachable";
export type ReferenceKind = "call" | "construct" | "type" | "inheritance" | "metadata";
export type Resolution = "exact" | "conservative" | "unresolved";

export interface SourceLocation {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface ApexSymbol {
  id: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  ownerId?: string;
  arity?: number;
  parameterTypes?: string[];
  parameterNames?: string[];
  modifiers: string[];
  annotations: string[];
  interfaces: string[];
  superclass?: string;
  testCode: boolean;
  location: SourceLocation;
  sourceCharacters: number;
  sourceBytes: number;
}

export interface RawReference {
  sourceId?: string | undefined;
  kind: ReferenceKind;
  memberName?: string | undefined;
  arity?: number | undefined;
  receiver?: string | undefined;
  receiverType?: string | undefined;
  targetType?: string | undefined;
  testContext: boolean;
  location: SourceLocation;
  detail: string;
}

export interface ReferenceEdge {
  sourceId?: string;
  targetId?: string;
  kind: ReferenceKind;
  resolution: Resolution;
  testContext: boolean;
  location: SourceLocation;
  detail: string;
}

export interface EntryPoint {
  symbolId: string;
  source: "platform" | "annotation" | "metadata" | "test";
  reason: string;
  testOnly: boolean;
  location: SourceLocation;
}

export interface AnalysisBlocker {
  code:
    | "dynamic-type"
    | "unresolved-reference"
    | "parse-error"
    | "duplicate-symbol";
  scope: "project" | "symbol" | "reference";
  message: string;
  blocksClosedWorldConclusion: boolean;
  symbolId?: string;
  repositoryMetadataField?: string;
  location?: SourceLocation;
}

export interface ExposureSignal {
  symbolId: string;
  kind: "annotation" | "visibility" | "platform-callback" | "webservice";
  reason: string;
  location: SourceLocation;
}

export interface RecoveryCandidate {
  symbolId: string;
  kind: SymbolKind;
  qualifiedName: string;
  classification: "unreachable-in-repository";
  sourceCharacters: number;
  sourceBytes: number;
  reasons: string[];
  exposures: string[];
  location: SourceLocation;
}

export interface ParseDiagnostic {
  path: string;
  line: number;
  column: number;
  message: string;
}

export interface SoqlObservation {
  symbolId: string;
  object: string;
  fields: string[];
  filterShape: string;
  normalizedQuery: string;
  dynamic: boolean;
  securityMode: "user" | "system" | "security-enforced" | "unspecified";
  sharingContext: "with-sharing" | "without-sharing" | "inherited-sharing" | "unspecified";
  aggregate: boolean;
  locking: boolean;
  location: SourceLocation;
}

export interface DmlObservation {
  symbolId: string;
  operation: "insert" | "update" | "delete" | "undelete" | "upsert" | "merge";
  targetExpression: string;
  targetType?: string;
  allOrNone: "default" | "true" | "false" | "dynamic";
  accessMode: "default" | "user" | "system" | "dynamic";
  location: SourceLocation;
}

export interface DynamicQueryGap {
  symbolId: string;
  expression: string;
  reason: string;
  location: SourceLocation;
}

export interface ExecutableBehavior {
  symbolId: string;
  statements: number;
  branches: number;
  loops: number;
  tryBlocks: number;
  throws: number;
  assignments: number;
  assignmentTargets: string[];
  enhancedForLoops: Array<{ variable: string; collection: string }>;
  advancedCollectionTypes: string[];
  callDetails: string[];
  queries: SoqlObservation[];
  dynamicQueryGaps: DynamicQueryGap[];
  dml: DmlObservation[];
}

export interface CloneOccurrence {
  symbolId: string;
  path: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  tokenCount: number;
  sourceCharacters: number;
}

export interface CloneGroup {
  id: string;
  kind: "exact" | "parameterized" | "near-miss";
  profile: "exact-token" | "identifier-and-literal-parameterized" | "verified-near-miss-strong" | "verified-near-miss-broad";
  similarity: number;
  duplicatedTokens: number;
  duplicatedCharacters: number;
  differences: string[];
  occurrences: CloneOccurrence[];
}

export interface QueryFamily {
  id: string;
  object: string;
  kind: "exact-query" | "selector-family";
  commonFields: string[];
  unionFields: string[];
  filterShapes: string[];
  occurrences: SoqlObservation[];
  recommendation: string;
}

export interface DmlFamily {
  id: string;
  operation: DmlObservation["operation"];
  targetType: string;
  occurrences: DmlObservation[];
  recommendation: string;
}

export interface DuplicateAnalysis {
  coverage: {
    status: "complete" | "blocked";
    blockedFiles: string[];
    testFilesExcluded: number;
  };
  productionTokens: number;
  cloneCoverageTokens: number;
  cloneCoverageTokenPercent: number;
  cloneCoverageCharacters: number;
  cloneCoverageCharacterPercent: number;
  duplicatedTokens: number;
  duplicatedTokenPercent: number;
  duplicatedCharacters: number;
  duplicatedCharacterPercent: number;
  cloneGroups: CloneGroup[];
  queryFamilies: QueryFamily[];
  queryCoverage: {
    status: "complete" | "blocked";
    unresolvedDynamicQueries: DynamicQueryGap[];
  };
  dmlFamilies: DmlFamily[];
  algorithm: {
    minimumFragmentTokens: number;
    minimumMethodTokens: number;
    nearMissSimilarity: number;
    nearMissBroadSimilarity: number;
    nearMissBroadMinimumTokens: number;
    testCodeExcluded: true;
    overlappingIntervalsDeduplicated: true;
  };
}

export interface FlowMigrationAssessment {
  triggerSymbolId: string;
  triggerName: string;
  object: string;
  events: string[];
  status: "eligible" | "ineligible" | "blocked";
  kind: "before-save-field-update" | "after-save-record-action" | "after-save-orchestration" | "unsupported";
  pathSymbolIds: string[];
  statements: number;
  branches: number;
  loops: number;
  queries: SoqlObservation[];
  dml: DmlObservation[];
  reclaimableArtifacts: Array<{
    path: string;
    action: "delete-file" | "remove-member";
    symbolIds: string[];
    sourceCharacters: number;
  }>;
  reclaimableCharacters: number;
  reclaimablePercent: number;
  reasons: string[];
  blockers: string[];
  location: SourceLocation;
}

export interface FlowMigrationAnalysis {
  eligibleTriggers: number;
  blockedTriggers: number;
  ineligibleTriggers: number;
  reclaimableCharacters: number;
  reclaimablePercent: number;
  assessments: FlowMigrationAssessment[];
}

export interface RecordAutomationObservation {
  kind: "flow" | "workflow";
  object: string;
  timing: string;
  path: string;
}

export interface RepositoryRevision {
  available: boolean;
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

export interface ProjectInventory {
  root: string;
  sourceRoots: string[];
  apexFiles: number;
  metadataFiles: number;
  apexCharacters: number;
  apexBytes: number;
  productionApexCharacters: number;
  productionApexBytes: number;
  testApexCharacters: number;
  testApexBytes: number;
}

export interface AnalysisSummary {
  symbols: number;
  classes: number;
  methods: number;
  entryPoints: number;
  resolvedReferences: number;
  unresolvedReferences: number;
  productionReachable: number;
  testOnlyReachable: number;
  unreachable: number;
  candidateClasses: number;
  candidateMethods: number;
  candidateClassCharacters: number;
  candidateClassBytes: number;
}

export interface ExecutiveWasteSummary {
  productionCharacters: number;
  deprecationCandidateCharacters: number;
  deprecationCandidatePercent: number;
  retainedCharacters: number;
  retainedPercent: number;
  topLevelCandidateFiles: number;
  internalRefactorCandidates: number;
  redundancy: {
    status: "measured";
    coveredCharacters: number;
    coveredPercent: number;
    duplicatedCharacters: number;
    duplicatedPercent: number;
    cloneGroups: number;
    queryFamilies: number;
    reason: string;
  };
  flowAutomation: {
    eligibleTriggers: number;
    reclaimableCharacters: number;
    reclaimablePercent: number;
  };
}

export interface AnalysisReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  tool: { name: "apex-reach"; version: string };
  generatedAt: string;
  inventory: ProjectInventory;
  summary: AnalysisSummary;
  executive: ExecutiveWasteSummary;
  revision: RepositoryRevision;
  duplicates: DuplicateAnalysis;
  flowMigration: FlowMigrationAnalysis;
  analysis: {
    universe: "repository";
    assumption: string;
    status: "complete" | "blocked";
    blockers: AnalysisBlocker[];
  };
  symbols: ApexSymbol[];
  references: ReferenceEdge[];
  entryPoints: EntryPoint[];
  reachability: Record<string, Reachability>;
  evidencePaths: Record<string, string[]>;
  candidates: RecoveryCandidate[];
  exposures: ExposureSignal[];
  diagnostics: ParseDiagnostic[];
}

export interface AnalysisOptions {
  include?: string[];
  exclude?: string[];
  fullGraph?: boolean;
}

export interface ExtractedFile {
  path: string;
  source: string;
  characters: number;
  bytes: number;
  symbols: ApexSymbol[];
  references: RawReference[];
  entryPoints: EntryPoint[];
  blockers: AnalysisBlocker[];
  exposures: ExposureSignal[];
  behaviors: ExecutableBehavior[];
  diagnostics: ParseDiagnostic[];
}
