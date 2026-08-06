import type {
  AnalysisBlocker,
  ApexSymbol,
  EntryPoint,
  ExecutableBehavior,
  ExtractedFile,
  RawReference,
  Reachability,
  ReferenceEdge,
  SourceLocation,
} from "./model.js";
import { normalizeName, simpleTypeName } from "./paths.js";

interface DynamicTypeResolutionInput {
  blockers: AnalysisBlocker[];
  files: ExtractedFile[];
  symbols: ApexSymbol[];
  references: ReferenceEdge[];
  entryPoints: EntryPoint[];
  reachability: Record<string, Reachability>;
  configuredTypeFields: ReadonlySet<string>;
}

interface DynamicTypeResolution {
  blockers: AnalysisBlocker[];
  references: RawReference[];
}

interface Provenance {
  metadataFields: Set<string>;
  typeNames: Set<string>;
  parameters: Set<number>;
  reasons: Set<string>;
  unknown: boolean;
}

/** Resolves only dynamic type names whose complete repository provenance is proven. */
export function resolveRepositoryDynamicTypes(input: DynamicTypeResolutionInput): DynamicTypeResolution {
  const behaviors = new Map(input.files.flatMap((file) => file.behaviors).map((behavior) => [behavior.symbolId, behavior]));
  const symbols = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
  const callTargets = buildCallTargetIndex(symbols, input.symbols);
  const resolvedCalls = buildResolvedCallIndex(input.references, symbols);
  const returnTypes = inferRepositoryMetadataReturns(behaviors, symbols, callTargets, resolvedCalls);
  const evaluator = new ProvenanceEvaluator(behaviors, symbols, callTargets, resolvedCalls, returnTypes);
  const entryIds = new Set(input.entryPoints.filter((entry) => !entry.testOnly).map((entry) => entry.symbolId));
  const addedReferences: RawReference[] = [];
  const remaining: AnalysisBlocker[] = [];

  for (const blocker of input.blockers) {
    if (blocker.code !== "dynamic-type" || !blocker.symbolId || !blocker.dynamicExpression
      || input.reachability[blocker.symbolId] !== "production") {
      remaining.push(blocker);
      continue;
    }
    const direct = evaluator.dynamicValue(blocker.dynamicExpression, blocker.symbolId, blocker.location);
    const expanded = expandParameters(direct, blocker.symbolId, evaluator, input.references, input.reachability, entryIds, new Set());
    const fieldsResolved = [...expanded.metadataFields].every((field) => input.configuredTypeFields.has(field));
    const hasEvidence = expanded.metadataFields.size > 0 || expanded.typeNames.size > 0;
    if (expanded.unknown || expanded.parameters.size > 0 || !fieldsResolved || !hasEvidence) {
      const reasons = new Set(expanded.reasons);
      for (const field of expanded.metadataFields) {
        if (!input.configuredTypeFields.has(field)) reasons.add(`no versioned Custom Metadata record contains ${field}`);
      }
      if (!hasEvidence) reasons.add("no literal class name or versioned Custom Metadata field was proven");
      const dynamicReasons = [...reasons].sort((left, right) => left.localeCompare(right));
      remaining.push({
        ...blocker,
        ...(dynamicReasons.length > 0 ? { dynamicReasons } : {}),
        message: dynamicReasons.length > 0
          ? `${blocker.message} Unresolved provenance: ${dynamicReasons.join("; ")}.`
          : blocker.message,
      });
      continue;
    }
    for (const targetType of expanded.typeNames) {
      addedReferences.push({
        sourceId: blocker.symbolId,
        kind: "type",
        targetType,
        testContext: false,
        location: blocker.location ?? symbols.get(blocker.symbolId)?.location ?? { path: "project", line: 1, column: 1 },
        detail: `Resolved Type.forName value: ${targetType}`,
      });
    }
  }

  return { blockers: remaining, references: addedReferences };
}

class ProvenanceEvaluator {
  constructor(
    private readonly behaviors: Map<string, ExecutableBehavior>,
    private readonly symbols: Map<string, ApexSymbol>,
    private readonly callTargets: Map<string, ApexSymbol[]>,
    private readonly resolvedCalls: Map<string, ApexSymbol[]>,
    private readonly returnTypes: Map<string, string>,
  ) {}

  dynamicValue(expression: string, symbolId: string, before?: SourceLocation, seen = new Set<string>()): Provenance {
    const value = unwrap(expression.trim());
    const key = `${symbolId}|${before?.line ?? 0}:${before?.column ?? 0}|${value}`;
    if (seen.has(key)) return unknown(`cyclic value propagation at ${this.describe(symbolId, value)}`);
    const nextSeen = new Set(seen).add(key);
    const literal = /^'(?:\\.|[^'])*'$/.test(value)
      ? value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\")
      : undefined;
    if (literal !== undefined) return provenance({ typeNames: [literal] });

    const field = this.metadataField(value, symbolId, before, nextSeen);
    if (field) return provenance({ metadataFields: [field] });

    if (/^[A-Za-z_]\w*$/.test(value)) {
      const symbol = this.symbols.get(symbolId);
      const parameter = symbol?.parameterNames?.findIndex((name) => normalizeName(name) === normalizeName(value)) ?? -1;
      if (parameter >= 0) return provenance({ parameters: [parameter] });
      const bindings = reachingBindings(this.behaviors.get(symbolId), value, before);
      if (bindings.length === 0) return unknown(`no repository value binding for ${this.describe(symbolId, value)}`);
      if (!bindings.some((binding) => !binding.conditional)) return unknown(`value is assigned only on conditional paths at ${this.describe(symbolId, value)}`);
      const result = provenance();
      for (const binding of bindings) {
        merge(result, this.dynamicValue(binding.expression, symbolId, binding.location, nextSeen));
      }
      return result;
    }

    const pieces = splitTopLevel(value, "+");
    if (pieces.length > 1) {
      const resolved = pieces.map((piece) => this.dynamicValue(piece, symbolId, before, nextSeen));
      if (resolved.every((item) => !item.unknown && item.metadataFields.size === 0 && item.parameters.size === 0 && item.typeNames.size === 1)) {
        return provenance({ typeNames: [resolved.map((item) => [...item.typeNames][0]!).join("")] });
      }
    }
    return unknown(`runtime expression at ${this.describe(symbolId, value)}`);
  }

  metadataType(expression: string, symbolId: string, before?: SourceLocation, seen = new Set<string>()): string | undefined {
    const value = unwrap(expression.trim());
    const normalized = normalizeName(value);
    const soql = /from([A-Za-z_]\w*__mdt)/i.exec(normalized)?.[1];
    if (soql) return soql;
    const getter = /([A-Za-z_]\w*__mdt)\.(?:getall|getinstance)\(/i.exec(normalized)?.[1];
    if (getter) return getter;

    const collectionBase = stripCollectionAccess(value);
    if (collectionBase !== value) return this.metadataType(collectionBase, symbolId, before, seen);
    if (/^[A-Za-z_]\w*$/.test(value)) {
      const bindings = reachingBindings(this.behaviors.get(symbolId), value, before);
      if (bindings.length === 0 || !bindings.some((binding) => !binding.conditional)) return undefined;
      const types = new Set<string>();
      for (const binding of bindings) {
        const key = `${symbolId}|${binding.location.line}:${binding.location.column}|${value}`;
        if (seen.has(key)) return undefined;
        const type = this.metadataType(binding.expression, symbolId, binding.location, new Set(seen).add(key));
        if (!type) return undefined;
        types.add(type);
      }
      return types.size === 1 ? [...types][0] : undefined;
    }

    const call = parseCall(value);
    if (!call) return undefined;
    const targets = this.resolvedCalls.get(resolvedCallKey(symbolId, value))
      ?? resolveCallTargets(call.receiver, call.name, call.arguments.length, symbolId, this.symbols, this.callTargets);
    const types = new Set(targets.map((target) => this.returnTypes.get(target.id)).filter((item): item is string => Boolean(item)));
    return types.size === 1 && targets.length > 0 && targets.every((target) => this.returnTypes.has(target.id)) ? [...types][0] : undefined;
  }

  private metadataField(expression: string, symbolId: string, before: SourceLocation | undefined, seen: Set<string>): string | undefined {
    const match = /^([\s\S]+)\.([A-Za-z_]\w*__c)$/.exec(expression);
    if (!match?.[1] || !match[2]) return undefined;
    const metadataType = this.metadataType(stripCollectionAccess(match[1]), symbolId, before, seen);
    return metadataType ? normalizeName(`${metadataType}.${match[2]}`) : undefined;
  }

  describe(symbolId: string, expression: string): string {
    return `${this.label(symbolId)}: ${expression}`;
  }

  label(symbolId: string): string {
    return this.symbols.get(symbolId)?.qualifiedName ?? symbolId;
  }
}

function inferRepositoryMetadataReturns(
  behaviors: Map<string, ExecutableBehavior>,
  symbols: Map<string, ApexSymbol>,
  callTargets: Map<string, ApexSymbol[]>,
  resolvedCalls: Map<string, ApexSymbol[]>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (let iteration = 0; iteration < Math.max(1, behaviors.size); iteration += 1) {
    let changed = false;
    const evaluator = new ProvenanceEvaluator(behaviors, symbols, callTargets, resolvedCalls, result);
    for (const behavior of behaviors.values()) {
      if (behavior.returnExpressions.length === 0) continue;
      const types = behavior.returnExpressions.map((item) => evaluator.metadataType(item.expression, behavior.symbolId, item.location));
      if (types.some((item) => !item) || new Set(types).size !== 1) continue;
      const type = types[0]!;
      if (result.get(behavior.symbolId) !== type) {
        result.set(behavior.symbolId, type);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

function expandParameters(
  value: Provenance,
  methodId: string,
  evaluator: ProvenanceEvaluator,
  references: ReferenceEdge[],
  reachability: Record<string, Reachability>,
  entryIds: Set<string>,
  seen: Set<string>,
): Provenance {
  const result = provenance({
    metadataFields: value.metadataFields,
    typeNames: value.typeNames,
    reasons: value.reasons,
    unknown: value.unknown,
  });
  for (const parameter of value.parameters) {
    const key = `${methodId}|${parameter}`;
    if (seen.has(key) || entryIds.has(methodId)) {
      result.unknown = true;
      result.reasons.add(seen.has(key)
        ? `cyclic parameter propagation at ${evaluator.label(methodId)} parameter ${parameter + 1}`
        : `production entry point supplies ${evaluator.label(methodId)} parameter ${parameter + 1}`);
      continue;
    }
    const incoming = references.filter((reference) => reference.targetId === methodId
      && reference.sourceId && reachability[reference.sourceId] === "production" && !reference.testContext);
    if (incoming.length === 0) {
      result.unknown = true;
      result.reasons.add(`no production caller was found for ${evaluator.label(methodId)} parameter ${parameter + 1}`);
      continue;
    }
    for (const reference of incoming) {
      const argument = reference.arguments?.[parameter];
      if (!argument || !reference.sourceId) {
        result.unknown = true;
        result.reasons.add(`production call at ${reference.location.path}:${reference.location.line} has no analyzable argument ${parameter + 1}`);
        continue;
      }
      const direct = evaluator.dynamicValue(argument, reference.sourceId, reference.location);
      merge(result, expandParameters(direct, reference.sourceId, evaluator, references, reachability, entryIds, new Set(seen).add(key)));
    }
  }
  return result;
}

function reachingBindings(
  behavior: ExecutableBehavior | undefined,
  name: string,
  before?: SourceLocation,
): Array<ExecutableBehavior["valueBindings"][number]> {
  const normalized = normalizeName(name);
  const bindings = (behavior?.valueBindings ?? [])
    .filter((binding) => normalizeName(binding.name) === normalized && (!before || compareLocation(binding.location, before) <= 0))
    .sort((left, right) => compareLocation(left.location, right.location));
  let lastUnconditional = -1;
  for (let index = bindings.length - 1; index >= 0; index -= 1) {
    if (!bindings[index]!.conditional) {
      lastUnconditional = index;
      break;
    }
  }
  return lastUnconditional < 0
    ? bindings
    : bindings.slice(lastUnconditional).filter((binding, index) => index === 0 || binding.conditional);
}

function resolveCallTargets(
  receiver: string | undefined,
  name: string,
  arity: number,
  sourceId: string,
  symbols: Map<string, ApexSymbol>,
  callTargets: Map<string, ApexSymbol[]>,
): ApexSymbol[] {
  const source = symbols.get(sourceId);
  const expectedOwner = receiver ? normalizeName(simpleTypeName(receiver)) : normalizeName(simpleTypeName(symbols.get(source?.ownerId ?? "")?.qualifiedName ?? ""));
  return callTargets.get(callTargetKey(expectedOwner, name, arity)) ?? [];
}

function buildCallTargetIndex(symbols: Map<string, ApexSymbol>, allSymbols: ApexSymbol[]): Map<string, ApexSymbol[]> {
  const result = new Map<string, ApexSymbol[]>();
  for (const symbol of allSymbols) {
    if (symbol.kind !== "method" && symbol.kind !== "constructor") continue;
    const owner = normalizeName(simpleTypeName(symbols.get(symbol.ownerId ?? "")?.qualifiedName ?? ""));
    const key = callTargetKey(owner, symbol.name, symbol.arity ?? 0);
    const existing = result.get(key);
    if (existing) existing.push(symbol);
    else result.set(key, [symbol]);
  }
  return result;
}

function buildResolvedCallIndex(references: ReferenceEdge[], symbols: Map<string, ApexSymbol>): Map<string, ApexSymbol[]> {
  const result = new Map<string, ApexSymbol[]>();
  for (const reference of references) {
    if (reference.kind !== "call" || !reference.sourceId || !reference.targetId) continue;
    const target = symbols.get(reference.targetId);
    if (!target || (target.kind !== "method" && target.kind !== "constructor")) continue;
    const key = resolvedCallKey(reference.sourceId, reference.detail);
    const existing = result.get(key);
    if (existing && !existing.some((item) => item.id === target.id)) existing.push(target);
    else if (!existing) result.set(key, [target]);
  }
  return result;
}

function resolvedCallKey(sourceId: string, expression: string): string {
  return `${sourceId}|${normalizeName(expression)}`;
}

function callTargetKey(owner: string, name: string, arity: number): string {
  return `${normalizeName(owner)}|${normalizeName(name)}/${arity}`;
}

function parseCall(expression: string): { receiver?: string; name: string; arguments: string[] } | undefined {
  const withoutValues = expression.replace(/\.values\(\)$/i, "");
  const match = /^(?:(.+)\.)?([A-Za-z_]\w*)\(([\s\S]*)\)$/.exec(withoutValues);
  if (!match?.[2]) return undefined;
  const args = match[3]?.trim() ? splitTopLevel(match[3], ",") : [];
  return { ...(match[1] ? { receiver: match[1] } : {}), name: match[2], arguments: args };
}

function stripCollectionAccess(expression: string): string {
  let result = expression;
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result.replace(/\.get\([^()]*\)$/i, "").replace(/\[[^\]]+\]$/, "").replace(/\.values\(\)$/i, "");
  }
  return result;
}

function splitTopLevel(value: string, separator: string): string[] {
  const result: string[] = [];
  let quoted = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === separator && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result;
}

function unwrap(value: string): string {
  let result = value;
  while (result.startsWith("(") && result.endsWith(")")) result = result.slice(1, -1).trim();
  return result;
}

function provenance(values: {
  metadataFields?: Iterable<string>;
  typeNames?: Iterable<string>;
  parameters?: Iterable<number>;
  reasons?: Iterable<string>;
  unknown?: boolean;
} = {}): Provenance {
  return {
    metadataFields: new Set(values.metadataFields ?? []),
    typeNames: new Set(values.typeNames ?? []),
    parameters: new Set(values.parameters ?? []),
    reasons: new Set(values.reasons ?? []),
    unknown: values.unknown ?? false,
  };
}

function unknown(reason: string): Provenance {
  return provenance({ reasons: [reason], unknown: true });
}

function merge(target: Provenance, source: Provenance): void {
  for (const item of source.metadataFields) target.metadataFields.add(item);
  for (const item of source.typeNames) target.typeNames.add(item);
  for (const item of source.parameters) target.parameters.add(item);
  for (const item of source.reasons) target.reasons.add(item);
  target.unknown ||= source.unknown;
}

function compareLocation(left: SourceLocation, right: SourceLocation): number {
  return left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column;
}
