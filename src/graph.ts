import type {
  ApexSymbol,
  Confidence,
  EntryPoint,
  RawReference,
  Reachability,
  RecoveryCandidate,
  ReferenceEdge,
  Uncertainty,
} from "./model.js";
import { normalizeName, simpleTypeName } from "./paths.js";

interface GraphResult {
  references: ReferenceEdge[];
  entryPoints: EntryPoint[];
  reachability: Record<string, Reachability>;
  evidencePaths: Record<string, string[]>;
  candidates: RecoveryCandidate[];
  uncertainties: Uncertainty[];
}

const BUILTIN_RECEIVERS = new Set([
  "blob", "boolean", "date", "datetime", "decimal", "double", "id", "integer", "long", "object",
  "string", "time", "list", "map", "set", "system", "database", "schema", "test", "type", "math", "limits",
]);

export function buildGraph(
  symbols: ApexSymbol[],
  rawReferences: RawReference[],
  declaredEntries: EntryPoint[],
  initialUncertainties: Uncertainty[],
): GraphResult {
  const index = new SymbolIndex(symbols);
  const references: ReferenceEdge[] = [];
  const entryPoints = [...declaredEntries];
  const uncertainties = [...initialUncertainties];

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
        });
        uncertainties.push({
          code: "unresolved-reference",
          scope: "reference",
          message: `Could not resolve ${raw.detail}.`,
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
    if (targets.length > 1) {
      uncertainties.push({
        code: "ambiguous-dispatch",
        scope: "reference",
        message: `${raw.detail} conservatively resolves to ${targets.length} symbols.`,
        ...(raw.sourceId ? { symbolId: raw.sourceId } : {}),
        location: raw.location,
      });
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
  const candidates = buildCandidates(symbols, reachability, uncertainties);
  return { references, entryPoints: uniqueEntries, reachability, evidencePaths, candidates, uncertainties };
}

class SymbolIndex {
  readonly byId = new Map<string, ApexSymbol>();
  readonly types = new Map<string, ApexSymbol[]>();
  readonly methodsByOwnerNameArity = new Map<string, ApexSymbol[]>();
  readonly methodsByNameArity = new Map<string, ApexSymbol[]>();

  constructor(symbols: ApexSymbol[]) {
    for (const symbol of symbols) {
      this.byId.set(symbol.id, symbol);
      if (isType(symbol)) {
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
}

function resolveReference(raw: RawReference, index: SymbolIndex): ApexSymbol[] {
  if (raw.kind === "type" || raw.kind === "inheritance") {
    return raw.targetType ? index.findTypes(raw.targetType) : [];
  }

  if (raw.kind === "construct") {
    if (!raw.targetType) return [];
    const types = index.findTypes(raw.targetType);
    const constructors = types.flatMap((type) => index.findMembers(type.id, type.name, raw.arity));
    return constructors.length > 0 ? unique(constructors) : types;
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
      return types;
    }
    const memberName = raw.memberName;
    return unique(types.flatMap((type) => index.findMembers(type.id, memberName)));
  }

  if (raw.kind === "call" && raw.memberName) {
    const receiverTypes = raw.receiverType ? index.findTypes(raw.receiverType) : [];
    const owned = receiverTypes.flatMap((type) => index.findMembers(type.id, raw.memberName!, raw.arity));
    if (owned.length > 0) return unique(owned);
    const receiverSimple = normalizeName(simpleTypeName(raw.receiverType ?? ""));
    if (BUILTIN_RECEIVERS.has(receiverSimple)) return [];
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
  uncertainties: Uncertainty[],
): RecoveryCandidate[] {
  const hasDynamicType = uncertainties.some((item) => item.code === "dynamic-type");
  const symbolUncertainties = new Map<string, Uncertainty[]>();
  for (const uncertainty of uncertainties) {
    if (uncertainty.symbolId) add(symbolUncertainties, uncertainty.symbolId, uncertainty);
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
    const attached = symbolUncertainties.get(symbol.id) ?? [];
    const confidence = candidateConfidence(symbol, attached, hasDynamicType);
    candidates.push({
      symbolId: symbol.id,
      kind: symbol.kind,
      qualifiedName: symbol.qualifiedName,
      confidence,
      sourceCharacters: symbol.sourceCharacters,
      sourceBytes: symbol.sourceBytes,
      reasons: [
        "No path from a known production entry point was found.",
        ...(isType(symbol) ? ["No production-reachable member was found in this top-level type."] : []),
      ],
      uncertainties: [
        ...attached.map((item) => item.message),
        ...(hasDynamicType && isTypeOrConstructor(symbol)
          ? ["The project contains a computed Type.forName reference."]
          : []),
      ],
      location: symbol.location,
    });
  }
  return candidates.sort(compareCandidates);
}

function candidateConfidence(symbol: ApexSymbol, attached: Uncertainty[], hasDynamicType: boolean): Confidence {
  let risk = 0;
  if (attached.some((item) => item.code === "external-callable")) risk += 1;
  if (hasDynamicType && isTypeOrConstructor(symbol)) risk += 1;
  return risk >= 2 ? "low" : risk === 1 ? "medium" : "high";
}

function shouldReportUnresolved(raw: RawReference, index: SymbolIndex): boolean {
  if (raw.kind === "call") {
    const receiver = normalizeName(simpleTypeName(raw.receiverType ?? ""));
    if (BUILTIN_RECEIVERS.has(receiver)) return false;
    if (raw.receiverType && index.findTypes(raw.receiverType).length === 0 && /^[A-Z]/.test(raw.receiverType)) return false;
  }
  if ((raw.kind === "type" || raw.kind === "inheritance") && raw.targetType) {
    const type = normalizeName(simpleTypeName(raw.targetType));
    if (BUILTIN_RECEIVERS.has(type) || /^[A-Z][A-Za-z0-9_]*__(c|mdt|e|b|x)$/i.test(simpleTypeName(raw.targetType))) return false;
  }
  return raw.kind === "metadata" || raw.kind === "construct" || raw.kind === "call";
}

function isType(symbol: ApexSymbol): boolean {
  return symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum" || symbol.kind === "trigger";
}

function isTypeOrConstructor(symbol: ApexSymbol): boolean {
  return isType(symbol) || symbol.kind === "constructor";
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
  const confidenceOrder: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  return confidenceOrder[left.confidence] - confidenceOrder[right.confidence]
    || right.sourceBytes - left.sourceBytes
    || left.qualifiedName.localeCompare(right.qualifiedName);
}
