export const REPORT_SCHEMA_VERSION = "2.0.0" as const;

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
    status: "not-measured";
    reason: string;
  };
}

export interface AnalysisReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  tool: { name: "apex-reach"; version: string };
  generatedAt: string;
  inventory: ProjectInventory;
  summary: AnalysisSummary;
  executive: ExecutiveWasteSummary;
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
  characters: number;
  bytes: number;
  symbols: ApexSymbol[];
  references: RawReference[];
  entryPoints: EntryPoint[];
  blockers: AnalysisBlocker[];
  exposures: ExposureSignal[];
  diagnostics: ParseDiagnostic[];
}
