import type {
  AnalysisBlocker,
  ApexSymbol,
  EntryPoint,
  ExposureSignal,
  RawReference,
  Reachability,
  RecoveryCandidate,
  ReferenceEdge,
} from "./model.js";
import { normalizeName, simpleTypeName } from "./paths.js";

interface GraphResult {
  references: ReferenceEdge[];
  entryPoints: EntryPoint[];
  reachability: Record<string, Reachability>;
  evidencePaths: Record<string, string[]>;
  candidates: RecoveryCandidate[];
  blockers: AnalysisBlocker[];
  exposures: ExposureSignal[];
}

const BUILTIN_RECEIVERS = new Set([
  "blob", "boolean", "date", "datetime", "decimal", "double", "id", "integer", "long", "object",
  "string", "time", "list", "map", "set", "system", "database", "schema", "test", "type", "math", "limits",
]);

const PLATFORM_CALLBACKS: Record<string, Set<string>> = {
  queueable: new Set(["execute"]),
  schedulable: new Set(["execute"]),
  batchable: new Set(["start", "execute", "finish"]),
  callable: new Set(["call"]),
  inboundemailhandler: new Set(["handleinboundemail"]),
  installhandler: new Set(["oninstall"]),
  uninstallhandler: new Set(["onuninstall"]),
};

export function buildGraph(
  symbols: ApexSymbol[],
  rawReferences: RawReference[],
  declaredEntries: EntryPoint[],
  initialBlockers: AnalysisBlocker[],
  exposures: ExposureSignal[],
): GraphResult {
  const index = new SymbolIndex(symbols);
  const references: ReferenceEdge[] = [];
  const entryPoints = [...declaredEntries];
  const blockers = [...initialBlockers];

  for (const raw of rawReferences) {
    const targets = resolveReference(raw, index);
    if (targets.length === 0) {
      if (shouldReportUnresolved(raw, index)) {
        references.push({
          ...(raw.sourceId ? { sourceId: raw.sourceId } : {}),
          kind: raw.kind,
          resolution: "unresolved",
          testContext: raw.testContext,
          location: raw.location,
          detail: raw.detail,
          ...(raw.arguments ? { arguments: raw.arguments } : {}),
        });
        blockers.push({
          code: "unresolved-reference",
          scope: "reference",
          message: `Could not resolve ${raw.detail}.`,
          blocksClosedWorldConclusion: true,
          ...(raw.sourceId ? { symbolId: raw.sourceId } : {}),
          location: raw.location,
        });
      }
      continue;
    }

    const resolution = targets.length === 1 ? "exact" : "conservative";
    for (const target of targets) {
      references.push({
        ...(raw.sourceId ? { sourceId: raw.sourceId } : {}),
        targetId: target.id,
        kind: raw.kind,
        resolution,
        testContext: raw.testContext,
        location: raw.location,
        detail: raw.detail,
        ...(raw.arguments ? { arguments: raw.arguments } : {}),
      });
      if (!raw.sourceId && raw.kind === "metadata") {
        entryPoints.push({
          symbolId: target.id,
          source: "metadata",
          reason: raw.detail,
          testOnly: false,
          location: raw.location,
        });
      }
    }
  }

  const uniqueEntries = dedupeEntries(entryPoints);
  const production = traverse(symbols, references, uniqueEntries.filter((entry) => !entry.testOnly).map((entry) => entry.symbolId));
  const withTests = traverse(symbols, references, uniqueEntries.map((entry) => entry.symbolId));
  const reachability: Record<string, Reachability> = {};
  const evidencePaths: Record<string, string[]> = {};
  for (const symbol of symbols) {
    reachability[symbol.id] = production.reached.has(symbol.id)
      ? "production"
      : withTests.reached.has(symbol.id)
        ? "test-only"
        : "unreachable";
    evidencePaths[symbol.id] = production.reached.has(symbol.id)
      ? pathTo(symbol.id, production.parent)
      : withTests.reached.has(symbol.id)
        ? pathTo(symbol.id, withTests.parent)
        : [];
  }
  const relevantBlockers = blockers.filter((blocker) =>
    blocker.symbolId === undefined || reachability[blocker.symbolId] === "production",
  );
  const candidates = buildCandidates(symbols, reachability, exposures);
  return { references, entryPoints: uniqueEntries, reachability, evidencePaths, candidates, blockers: relevantBlockers, exposures };
}

class SymbolIndex {
  readonly byId = new Map<string, ApexSymbol>();
  readonly types = new Map<string, ApexSymbol[]>();
  readonly methodsByOwnerNameArity = new Map<string, ApexSymbol[]>();
  readonly methodsByNameArity = new Map<string, ApexSymbol[]>();
  private readonly allTypes: ApexSymbol[] = [];
  private readonly dispatchCache = new Map<string, ApexSymbol[]>();
  private readonly subtypeCache = new Map<string, boolean>();

  constructor(symbols: ApexSymbol[]) {
    for (const symbol of symbols) {
      this.byId.set(symbol.id, symbol);
      if (isType(symbol)) {
        this.allTypes.push(symbol);
        add(this.types, normalizeName(symbol.qualifiedName), symbol);
        add(this.types, normalizeName(symbol.name), symbol);
      }
      if (symbol.kind === "method" || symbol.kind === "constructor") {
        const memberKey = `${normalizeName(symbol.name)}/${symbol.arity ?? 0}`;
        add(this.methodsByNameArity, memberKey, symbol);
        if (symbol.ownerId) add(this.methodsByOwnerNameArity, `${symbol.ownerId}|${memberKey}`, symbol);
      }
    }
  }

  findTypes(name: string): ApexSymbol[] {
    const normalized = normalizeName(name);
    const simple = normalizeName(simpleTypeName(name));
    return unique([...(this.types.get(normalized) ?? []), ...(this.types.get(simple) ?? [])]);
  }

  findMembers(ownerId: string, name: string, arity?: number): ApexSymbol[] {
    if (arity !== undefined) return this.methodsByOwnerNameArity.get(`${ownerId}|${normalizeName(name)}/${arity}`) ?? [];
    const prefix = `${ownerId}|${normalizeName(name)}/`;
    return [...this.methodsByOwnerNameArity.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, values]) => values);
  }

  findMembersGlobally(name: string, arity?: number): ApexSymbol[] {
    if (arity !== undefined) return this.methodsByNameArity.get(`${normalizeName(name)}/${arity}`) ?? [];
    const prefix = `${normalizeName(name)}/`;
    return [...this.methodsByNameArity.entries()].filter(([key]) => key.startsWith(prefix)).flatMap(([, values]) => values);
  }

  findAllMembers(ownerId: string): ApexSymbol[] {
    const prefix = `${ownerId}|`;
    return [...this.methodsByOwnerNameArity.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, values]) => values);
  }

  findDispatchMembers(receiverTypes: ApexSymbol[], name: string, arity?: number): ApexSymbol[] {
    const cacheKey = `${receiverTypes.map((type) => type.id).sort().join(",")}|${normalizeName(name)}/${arity ?? "*"}`;
    const cached = this.dispatchCache.get(cacheKey);
    if (cached) return cached;
    const owners = unique(receiverTypes.flatMap((receiver) => [
      receiver,
      ...this.allTypes.filter((candidate) => this.isSubtypeOf(candidate, receiver)),
    ]));
    const result = unique(owners.flatMap((owner) => this.findMembers(owner.id, name, arity)));
    this.dispatchCache.set(cacheKey, result);
    return result;
  }

  findPlatformCallbacks(type: ApexSymbol): ApexSymbol[] {
    const callbackNames = new Set(
      type.interfaces.flatMap((implemented) => [
        ...(PLATFORM_CALLBACKS[normalizeName(simpleTypeName(implemented))] ?? []),
      ]),
    );
    return this.findAllMembers(type.id).filter((member) => callbackNames.has(normalizeName(member.name)));
  }

  private isSubtypeOf(candidate: ApexSymbol, expectedBase: ApexSymbol): boolean {
    const cacheKey = `${candidate.id}|${expectedBase.id}`;
    const cached = this.subtypeCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = this.computeSubtype(candidate, expectedBase, new Set<string>());
    this.subtypeCache.set(cacheKey, result);
    return result;
  }

  private computeSubtype(candidate: ApexSymbol, expectedBase: ApexSymbol, seen: Set<string>): boolean {
    if (candidate.id === expectedBase.id || seen.has(candidate.id)) return candidate.id === expectedBase.id;
    seen.add(candidate.id);
    const bases = [...candidate.interfaces, ...(candidate.superclass ? [candidate.superclass] : [])];
    for (const baseName of bases) {
      if (normalizeName(simpleTypeName(baseName)) === normalizeName(expectedBase.name)) return true;
      for (const base of this.findTypes(baseName)) {
        if (this.computeSubtype(base, expectedBase, seen)) return true;
      }
    }
    return false;
  }
}

function resolveReference(raw: RawReference, index: SymbolIndex): ApexSymbol[] {
  if (raw.kind === "type" || raw.kind === "inheritance") {
    return raw.targetType ? index.findTypes(raw.targetType) : [];
  }

  if (raw.kind === "construct") {
    if (!raw.targetType) return [];
    const types = index.findTypes(raw.targetType);
    const constructors = types.flatMap((type) => index.findMembers(type.id, type.name, raw.arity));
    const callbacks = types.flatMap((type) => index.findPlatformCallbacks(type));
    return unique([...(constructors.length > 0 ? constructors : types), ...callbacks]);
  }

  if (raw.kind === "metadata") {
    if (!raw.targetType) return [];
    const types = index.findTypes(raw.targetType);
    if (!raw.memberName) {
      if (raw.detail.startsWith("Visualforce controller")) {
        return unique([
          ...types,
          ...types.flatMap((type) => index.findAllMembers(type.id).filter((member) => member.modifiers.includes("public") || member.modifiers.includes("global"))),
        ]);
      }
      if (raw.detail.startsWith("Flow Apex action")) {
        return unique([
          ...types,
          ...types.flatMap((type) => index.findAllMembers(type.id).filter((member) => member.annotations.includes("invocablemethod"))),
        ]);
      }
      return types;
    }
    const memberName = raw.memberName;
    return unique(types.flatMap((type) => index.findMembers(type.id, memberName)));
  }

  if (raw.kind === "call" && raw.memberName) {
    const receiverTypes = raw.receiverType ? index.findTypes(raw.receiverType) : [];
    const owned = index.findDispatchMembers(receiverTypes, raw.memberName, raw.arity);
    if (owned.length > 0) return unique(owned);
    const receiverSimple = normalizeName(simpleTypeName(raw.receiverType ?? ""));
    if (BUILTIN_RECEIVERS.has(receiverSimple)) return [];
    if (raw.receiver && /^new[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\(/i.test(raw.receiver.replace(/\s+/g, ""))) return [];
    // Unknown chained receivers are conservatively dispatched to every local
    // method with the same name/arity. Constructed and typed receivers are
    // resolved before this point, preventing platform calls such as
    // `new Http().send(...)` from becoming false local edges.
    return unique(index.findMembersGlobally(raw.memberName, raw.arity));
  }
  return [];
}

function traverse(
  symbols: ApexSymbol[],
  references: ReferenceEdge[],
  seeds: string[],
): { reached: Set<string>; parent: Map<string, string | undefined> } {
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const outgoing = new Map<string, string[]>();
  for (const edge of references) {
    if (edge.sourceId && edge.targetId) add(outgoing, edge.sourceId, edge.targetId);
  }
  const reached = new Set<string>();
  const parent = new Map<string, string | undefined>();
  const queue = [...seeds];
  for (const seed of seeds) parent.set(seed, undefined);
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor++];
    if (!id || reached.has(id)) continue;
    reached.add(id);
    const symbol = byId.get(id);
    if (symbol?.ownerId && !reached.has(symbol.ownerId)) {
      if (!parent.has(symbol.ownerId)) parent.set(symbol.ownerId, id);
      queue.push(symbol.ownerId);
    }
    for (const target of outgoing.get(id) ?? []) {
      if (!reached.has(target)) {
        if (!parent.has(target)) parent.set(target, id);
        queue.push(target);
      }
    }
  }
  return { reached, parent };
}

function pathTo(id: string, parent: Map<string, string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = parent.get(current);
  }
  return result.reverse();
}

function buildCandidates(
  symbols: ApexSymbol[],
  reachability: Record<string, Reachability>,
  exposures: ExposureSignal[],
): RecoveryCandidate[] {
  const exposuresBySymbol = new Map<string, ExposureSignal[]>();
  for (const exposure of exposures) {
    add(exposuresBySymbol, exposure.symbolId, exposure);
  }
  const membersByOwner = new Map<string, ApexSymbol[]>();
  for (const symbol of symbols) {
    if (symbol.ownerId) add(membersByOwner, symbol.ownerId, symbol);
  }

  const candidates: RecoveryCandidate[] = [];
  for (const symbol of symbols) {
    if (symbol.testCode || reachability[symbol.id] !== "unreachable") continue;
    if (isType(symbol) && symbol.ownerId) continue;
    if (isType(symbol)) {
      const productionMembers = (membersByOwner.get(symbol.id) ?? []).filter((member) => !member.testCode);
      if (productionMembers.some((member) => reachability[member.id] !== "unreachable")) continue;
    }
    const relatedIds = isType(symbol)
      ? [symbol.id, ...(membersByOwner.get(symbol.id) ?? []).map((member) => member.id)]
      : [symbol.id];
    const attachedExposures = relatedIds.flatMap((id) => exposuresBySymbol.get(id) ?? []);
    candidates.push({
      symbolId: symbol.id,
      kind: symbol.kind,
      qualifiedName: symbol.qualifiedName,
      classification: "unreachable-in-repository",
      sourceCharacters: symbol.sourceCharacters,
      sourceBytes: symbol.sourceBytes,
      reasons: [
        "No path from a known production entry point was found.",
        ...(isType(symbol) ? ["No production-reachable member was found in this top-level type."] : []),
      ],
      exposures: [...new Set(attachedExposures.map((item) => item.reason))],
      location: symbol.location,
    });
  }
  return candidates.sort(compareCandidates);
}

function shouldReportUnresolved(raw: RawReference, index: SymbolIndex): boolean {
  if (raw.kind === "construct") {
    return Boolean(raw.targetType && index.findTypes(raw.targetType).length > 0);
  }
  return false;
}

function isType(symbol: ApexSymbol): boolean {
  return symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum" || symbol.kind === "trigger";
}

function add<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function unique<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function dedupeEntries(entries: EntryPoint[]): EntryPoint[] {
  return [...new Map(entries.map((entry) => [`${entry.symbolId}|${entry.source}|${entry.reason}|${entry.location.path}`, entry])).values()];
}

function compareCandidates(left: RecoveryCandidate, right: RecoveryCandidate): number {
  return right.sourceBytes - left.sourceBytes
    || left.qualifiedName.localeCompare(right.qualifiedName);
}
