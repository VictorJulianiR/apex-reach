import type {
  ApexSymbol,
  AnalysisBlocker,
  EntryPoint,
  ExecutableBehavior,
  ExtractedFile,
  FlowMigrationAnalysis,
  FlowMigrationAssessment,
  ReferenceEdge,
  RecordAutomationObservation,
} from "../model.js";

interface TriggerDescriptor {
  name: string;
  object: string;
  events: string[];
}

export function analyzeFlowMigration(
  files: ExtractedFile[],
  symbols: ApexSymbol[],
  references: ReferenceEdge[],
  entryPoints: EntryPoint[],
  productionCharacters: number,
  automations: RecordAutomationObservation[],
  analysisBlockers: AnalysisBlocker[],
): FlowMigrationAnalysis {
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const behaviorById = new Map(files.flatMap((file) => file.behaviors).map((behavior) => [behavior.symbolId, behavior]));
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const triggerDescriptors = new Map(symbols.filter((symbol) => symbol.kind === "trigger").map((symbol) => [
    symbol.id,
    describeTrigger(fileByPath.get(symbol.location.path)?.source ?? "", symbol.name),
  ]));
  const executableIds = new Set(files.flatMap((file) => file.behaviors.map((behavior) => behavior.symbolId)));
  const outgoing = executableEdges(references, executableIds);
  const incoming = incomingEdges(references, executableIds);
  const unresolvedSources = new Set(references.filter((reference) => reference.resolution === "unresolved" && reference.sourceId).map((reference) => reference.sourceId!));
  const entryIds = new Set(entryPoints.filter((entry) => !entry.testOnly).map((entry) => entry.symbolId));
  const assessments = symbols
    .filter((symbol) => symbol.kind === "trigger")
    .map((trigger) => assessTrigger(
      trigger,
      fileByPath.get(trigger.location.path),
      fileByPath,
      byId,
      behaviorById,
      outgoing,
      incoming,
      entryIds,
      productionCharacters,
      automations,
      triggerDescriptors,
      unresolvedSources,
      analysisBlockers,
      references,
    ))
    .sort((left, right) => statusOrder(left.status) - statusOrder(right.status) || right.reclaimableCharacters - left.reclaimableCharacters);
  const eligible = assessments.filter((assessment) => assessment.status === "eligible");
  const reclaimableCharacters = eligible.reduce((total, assessment) => total + assessment.reclaimableCharacters, 0);
  return {
    eligibleTriggers: eligible.length,
    blockedTriggers: assessments.filter((assessment) => assessment.status === "blocked").length,
    ineligibleTriggers: assessments.filter((assessment) => assessment.status === "ineligible").length,
    reclaimableCharacters,
    reclaimablePercent: percent(reclaimableCharacters, productionCharacters),
    assessments,
  };
}

function assessTrigger(
  trigger: ApexSymbol,
  file: ExtractedFile | undefined,
  filesByPath: Map<string, ExtractedFile>,
  byId: Map<string, ApexSymbol>,
  behaviorById: Map<string, ExecutableBehavior>,
  outgoing: Map<string, string[]>,
  incoming: Map<string, string[]>,
  entryIds: Set<string>,
  productionCharacters: number,
  automations: RecordAutomationObservation[],
  triggerDescriptors: Map<string, TriggerDescriptor>,
  unresolvedSources: Set<string>,
  analysisBlockers: AnalysisBlocker[],
  references: ReferenceEdge[],
): FlowMigrationAssessment {
  const descriptor = describeTrigger(file?.source ?? "", trigger.name);
  const traversal = traverseExecutables(trigger.id, outgoing);
  const pathSymbolIds = traversal.ids;
  const behaviors = pathSymbolIds.map((id) => behaviorById.get(id)).filter((item): item is ExecutableBehavior => Boolean(item));
  const statements = sum(behaviors, (behavior) => behavior.statements);
  const branches = sum(behaviors, (behavior) => behavior.branches);
  const loops = sum(behaviors, (behavior) => behavior.loops);
  const queries = behaviors.flatMap((behavior) => behavior.queries);
  const dml = behaviors.flatMap((behavior) => behavior.dml);
  const assignments = sum(behaviors, (behavior) => behavior.assignments);
  const recordMutationProof = proveTriggerRecordAssignments(trigger.id, pathSymbolIds, behaviors, byId, references);
  const coverageBlockers: string[] = [];
  if (pathSymbolIds.some((id) => unresolvedSources.has(id))) coverageBlockers.push("At least one call on this path is unresolved in the repository graph.");
  const pathLocations = new Set(pathSymbolIds.map((id) => byId.get(id)?.location.path).filter(Boolean));
  for (const blocker of analysisBlockers.filter((item) => item.blocksClosedWorldConclusion
    && (item.symbolId ? pathSymbolIds.includes(item.symbolId) : !item.location || pathLocations.has(item.location.path)))) {
    coverageBlockers.push(`${blocker.code}: ${blocker.message}`);
  }
  const blockers = semanticBlockers(behaviors, traversal.cycle, descriptor.events, dml.length);
  for (const automation of automations.filter((item) => item.object.toLowerCase() === descriptor.object.toLowerCase())) {
    blockers.push(`Existing ${automation.kind} automation on ${descriptor.object} (${automation.timing}) at ${automation.path} prevents an automatic order-equivalence proof.`);
  }
  const siblingTriggers = [...triggerDescriptors].filter(([id, item]) => id !== trigger.id && item.object.toLowerCase() === descriptor.object.toLowerCase());
  if (siblingTriggers.length > 0) blockers.push(`Other Apex trigger(s) on ${descriptor.object}: ${siblingTriggers.map(([, item]) => item.name).join(", ")}.`);
  for (const id of pathSymbolIds) {
    const owner = ownerOf(byId.get(id), byId);
    if (owner?.modifiers.some((modifier) => /(?:with|inherited)\s*sharing/i.test(modifier.replace(/\s+/g, " ")) || /(?:withsharing|inheritedsharing)/i.test(modifier))) {
      blockers.push(`${owner.qualifiedName} declares ${owner.modifiers.join(" ")}; record-triggered Flow security context is not mechanically equivalent.`);
    }
  }
  const reasons: string[] = [];
  const beforeOnly = descriptor.events.length > 0 && descriptor.events.every((event) => event.startsWith("before "));
  const afterOnly = descriptor.events.length > 0 && descriptor.events.every((event) => event.startsWith("after "));
  const simpleCallChain = traversal.maxDepth <= 4 && [...outgoing.entries()]
    .filter(([source]) => pathSymbolIds.includes(source))
    .every(([, targets]) => targets.filter((target) => pathSymbolIds.includes(target)).length <= 1);
  if (!simpleCallChain) reasons.push("The local call graph branches or exceeds four executable steps.");
  if (queries.length > 0) reasons.push(`${queries.length} SOQL operation(s) require a native Get Records mapping.`);
  if (loops > 0) reasons.push(`${loops} bulk loop(s) become per-record Flow interviews at the same bulkifiable element.`);
  if (branches > 0) reasons.push(`${branches} decision branch(es) must be reproduced explicitly.`);
  if (beforeOnly && assignments > 0 && !recordMutationProof.proven) blockers.push(...recordMutationProof.blockers);

  let kind: FlowMigrationAssessment["kind"] = "unsupported";
  let status: FlowMigrationAssessment["status"] = coverageBlockers.length > 0 ? "blocked" : "ineligible";
  if (coverageBlockers.length === 0 && blockers.length === 0 && beforeOnly && dml.length === 0 && assignments > 0 && queries.length === 0) {
    kind = "before-save-field-update";
    status = branches <= 1 && loops <= 1 && simpleCallChain ? "eligible" : "ineligible";
    reasons.push("The path only mutates records in a before-save trigger and has no explicit DML or SOQL.");
  } else if (coverageBlockers.length === 0 && blockers.length === 0 && afterOnly && dml.length === 1) {
    kind = "after-save-record-action";
    status = queries.length === 0 && branches === 0 && loops <= 1 && simpleCallChain ? "eligible" : "ineligible";
    reasons.push(`The after-save path ends in one ${dml[0]!.operation} operation${dml[0]!.targetType ? ` on ${dml[0]!.targetType}` : ""}.`);
  } else if (coverageBlockers.length === 0 && blockers.length === 0 && dml.length > 0) {
    kind = "after-save-orchestration";
    status = "ineligible";
    reasons.push("The path contains bounded record operations but needs transaction/order equivalence review.");
  } else if (coverageBlockers.length === 0 && blockers.length === 0) {
    blockers.push("No deterministic record mutation or record DML outcome was found.");
  }

  const exclusiveIds = pathSymbolIds.filter((id) => id === trigger.id || isExclusiveToTraversal(id, pathSymbolIds, incoming, entryIds));
  const reclaimableArtifacts = status === "eligible"
    ? reclaimableForPath(trigger, exclusiveIds, pathSymbolIds, byId, behaviorById, filesByPath, references, entryIds)
    : [];
  const reclaimableCharacters = reclaimableArtifacts.reduce((total, artifact) => total + artifact.sourceCharacters, 0);
  if (exclusiveIds.length < pathSymbolIds.length) reasons.push("Shared executable methods are excluded from the reclaimable-character estimate.");
  return {
    triggerSymbolId: trigger.id,
    triggerName: descriptor.name,
    object: descriptor.object,
    events: descriptor.events,
    status,
    kind,
    pathSymbolIds,
    statements,
    branches,
    loops,
    queries,
    dml,
    reclaimableArtifacts,
    reclaimableCharacters,
    reclaimablePercent: percent(reclaimableCharacters, productionCharacters),
    reasons,
    blockers: [...coverageBlockers, ...blockers],
    location: trigger.location,
  };
}

function reclaimableForPath(
  trigger: ApexSymbol,
  exclusiveIds: string[],
  pathIds: string[],
  byId: Map<string, ApexSymbol>,
  behaviorById: Map<string, ExecutableBehavior>,
  filesByPath: Map<string, ExtractedFile>,
  references: ReferenceEdge[],
  entryIds: Set<string>,
): FlowMigrationAssessment["reclaimableArtifacts"] {
  const path = new Set(pathIds);
  const exclusive = new Set(exclusiveIds);
  const artifacts: FlowMigrationAssessment["reclaimableArtifacts"] = [];
  const countedFiles = new Set<string>();
  const triggerFile = filesByPath.get(trigger.location.path);
  artifacts.push({
    path: trigger.location.path,
    action: "delete-file",
    symbolIds: [trigger.id],
    sourceCharacters: triggerFile?.characters ?? trigger.sourceCharacters,
  });
  countedFiles.add(trigger.location.path);

  for (const id of exclusiveIds) {
    const symbol = byId.get(id);
    if (!symbol || symbol.kind === "trigger") continue;
    const owner = ownerOf(symbol, byId);
    const ownerFile = owner ? filesByPath.get(owner.location.path) : undefined;
    if (owner && ownerFile && !countedFiles.has(owner.location.path) && canDeleteOwner(owner, ownerFile, exclusive, path, behaviorById, byId, references, entryIds)) {
      const members = ownerFile.behaviors.map((behavior) => behavior.symbolId).filter((memberId) => ownerOf(byId.get(memberId), byId)?.id === owner.id);
      artifacts.push({ path: owner.location.path, action: "delete-file", symbolIds: [owner.id, ...members], sourceCharacters: ownerFile.characters });
      countedFiles.add(owner.location.path);
      continue;
    }
    if (!countedFiles.has(symbol.location.path)) {
      artifacts.push({ path: symbol.location.path, action: "remove-member", symbolIds: [symbol.id], sourceCharacters: symbol.sourceCharacters });
    }
  }
  return artifacts;
}

function canDeleteOwner(
  owner: ApexSymbol,
  file: ExtractedFile,
  exclusive: Set<string>,
  path: Set<string>,
  behaviorById: Map<string, ExecutableBehavior>,
  byId: Map<string, ApexSymbol>,
  references: ReferenceEdge[],
  entryIds: Set<string>,
): boolean {
  const members = file.behaviors.map((behavior) => behavior.symbolId).filter((id) => behaviorById.has(id) && ownerOf(byId.get(id), byId)?.id === owner.id);
  if (members.length === 0 || members.some((id) => !exclusive.has(id))) return false;
  const targets = new Set([owner.id, ...members]);
  if ([...targets].some((id) => entryIds.has(id))) return false;
  return references.filter((reference) => reference.targetId && targets.has(reference.targetId)).every((reference) => reference.sourceId !== undefined && path.has(reference.sourceId));
}

function semanticBlockers(
  behaviors: ExecutableBehavior[],
  cycle: boolean,
  events: string[],
  dmlCount: number,
): string[] {
  const blockers: string[] = [];
  if (cycle) blockers.push("Recursive/cyclic executable calls were found.");
  if (events.some((event) => /delete|undelete/.test(event))) blockers.push("Delete/undelete trigger timing requires manual Flow order-of-execution validation.");
  if (new Set(events.map((event) => event.split(" ", 1)[0])).size > 1) blockers.push("The trigger mixes before and after events and would require separate flows.");
  const tryBlocks = sum(behaviors, (behavior) => behavior.tryBlocks);
  const throws = sum(behaviors, (behavior) => behavior.throws);
  if (tryBlocks > 0 || throws > 0) blockers.push("Apex exception control flow cannot be mechanically preserved by this migration.");
  if (dmlCount > 2) blockers.push("More than two DML outcomes make this an orchestration redesign, not a simple replacement.");
  const advancedCollections = [...new Set(behaviors.flatMap((behavior) => behavior.advancedCollectionTypes))];
  if (advancedCollections.length > 0) blockers.push(`Map/Set data structures without a native Flow equivalent were found: ${advancedCollections.join(", ")}.`);
  const dml = behaviors.flatMap((behavior) => behavior.dml);
  if (dml.some((item) => item.allOrNone === "false" || item.allOrNone === "dynamic")) blockers.push("Partial or computed allOrNone DML semantics cannot be mechanically preserved by this Flow profile.");
  if (dml.some((item) => item.accessMode === "user" || item.accessMode === "dynamic")) blockers.push("User-mode or computed-access DML security semantics are not mechanically equivalent to default record-triggered Flow context.");
  if (behaviors.some((behavior) => behavior.dynamicQueryGaps.length > 0)) blockers.push("An unresolved dynamic SOQL expression was found on the path.");
  const calls = behaviors.flatMap((behavior) => behavior.callDetails).join("\n");
  const unsupported: Array<[RegExp, string]> = [
    [/\b(?:newHttp|Http|HttpRequest|WebServiceCallout)\b/i, "HTTP/SOAP callout"],
    [/\b(?:enqueueJob|executeBatch|System\.schedule|System\.scheduleBatch)\b/i, "asynchronous Apex dispatch"],
    [/\bType\.forName\b/i, "dynamic Apex type construction"],
    [/\bDatabase\.(?:setSavepoint|rollback)\b/i, "savepoint/rollback transaction control"],
    [/\baddError\s*\(/i, "Apex addError behavior without a proven Custom Error mapping"],
    [/\bSchema\.|getDescribe\s*\(/i, "runtime schema describe"],
    [/\bMessaging\.|\bApproval\.|\bConnectApi\.|\bEventBus\.publish\b/i, "platform operation without mechanical Flow equivalence"],
    [/\bJSON\.deserializeUntyped\b/i, "untyped dynamic data"],
    [/\b(?:Crypto|BusinessHours|EncodingUtil)\./i, "Apex library operation without a proven native Flow mapping"],
  ];
  for (const [pattern, reason] of unsupported) if (pattern.test(calls)) blockers.push(`${reason} was found on the path.`);
  return [...new Set(blockers)];
}

function traverseExecutables(start: string, outgoing: Map<string, string[]>): { ids: string[]; cycle: boolean; maxDepth: number } {
  const ids: string[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  let cycle = false;
  let maxDepth = 0;
  const visit = (id: string, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    if (active.has(id)) {
      cycle = true;
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    ids.push(id);
    for (const target of outgoing.get(id) ?? []) visit(target, depth + 1);
    active.delete(id);
  };
  visit(start, 1);
  return { ids, cycle, maxDepth };
}

function executableEdges(references: ReferenceEdge[], executableIds: Set<string>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const reference of references) {
    if (!reference.sourceId || !reference.targetId || !executableIds.has(reference.sourceId) || !executableIds.has(reference.targetId)) continue;
    if (reference.kind !== "call" && reference.kind !== "construct") continue;
    add(result, reference.sourceId, reference.targetId);
  }
  for (const [source, targets] of result) result.set(source, [...new Set(targets)]);
  return result;
}

function incomingEdges(references: ReferenceEdge[], executableIds: Set<string>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const reference of references) {
    if (!reference.sourceId || !reference.targetId || !executableIds.has(reference.targetId)) continue;
    if (reference.kind !== "call" && reference.kind !== "construct") continue;
    add(result, reference.targetId, reference.sourceId);
  }
  for (const [target, sources] of result) result.set(target, [...new Set(sources)]);
  return result;
}

function isExclusiveToTraversal(id: string, traversal: string[], incoming: Map<string, string[]>, entryIds: Set<string>): boolean {
  const traversalSet = new Set(traversal);
  if (entryIds.has(id)) return false;
  return (incoming.get(id) ?? []).every((source) => traversalSet.has(source));
}

function describeTrigger(source: string, fallbackName: string): TriggerDescriptor {
  const match = /\btrigger\s+([A-Za-z_]\w*)\s+on\s+([A-Za-z_]\w*)\s*\(([^)]+)\)/i.exec(source);
  return {
    name: match?.[1] ?? fallbackName,
    object: match?.[2] ?? "unknown",
    events: (match?.[3] ?? "").split(",").map((event) => event.trim().toLowerCase()).filter(Boolean),
  };
}

function add(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 10_000) / 100;
}

function statusOrder(status: FlowMigrationAssessment["status"]): number {
  return status === "eligible" ? 0 : status === "blocked" ? 1 : 2;
}

function proveTriggerRecordAssignments(
  triggerId: string,
  pathIds: string[],
  behaviors: ExecutableBehavior[],
  byId: Map<string, ApexSymbol>,
  references: ReferenceEdge[],
): { proven: boolean; blockers: string[] } {
  const path = new Set(pathIds);
  const behaviorById = new Map(behaviors.map((behavior) => [behavior.symbolId, behavior]));
  const tainted = new Map<string, Set<string>>([[triggerId, new Set(["trigger.new", "trigger.newmap"])]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of pathIds) {
      const values = tainted.get(id) ?? new Set<string>();
      for (const loop of behaviorById.get(id)?.enhancedForLoops ?? []) {
        if (isTaintedExpression(loop.collection, values) && !values.has(loop.variable.toLowerCase())) {
          values.add(loop.variable.toLowerCase());
          changed = true;
        }
      }
      if (values.size > 0) tainted.set(id, values);
    }
    for (const edge of references) {
      if (!edge.sourceId || !edge.targetId || !path.has(edge.sourceId) || !path.has(edge.targetId)) continue;
      if (edge.kind !== "call" && edge.kind !== "construct") continue;
      const sourceValues = tainted.get(edge.sourceId) ?? new Set<string>();
      const target = byId.get(edge.targetId);
      const args = callArguments(edge.detail);
      for (let index = 0; index < args.length; index += 1) {
        const parameter = target?.parameterNames?.[index]?.toLowerCase();
        if (!parameter || !isTaintedExpression(args[index]!, sourceValues)) continue;
        const targetValues = tainted.get(edge.targetId) ?? new Set<string>();
        if (!targetValues.has(parameter)) {
          targetValues.add(parameter);
          tainted.set(edge.targetId, targetValues);
          changed = true;
        }
      }
    }
  }
  const unproven: string[] = [];
  for (const behavior of behaviors) {
    const values = tainted.get(behavior.symbolId) ?? new Set<string>();
    for (const target of behavior.assignmentTargets) {
      if (!isRecordFieldTarget(target, values)) unproven.push(`${behavior.symbolId}: ${target}`);
    }
  }
  return {
    proven: unproven.length === 0 && behaviors.some((behavior) => behavior.assignmentTargets.length > 0),
    blockers: unproven.length > 0
      ? [`Assignments not proven to target Trigger.new records: ${unproven.join(", ")}.`]
      : ["No field assignment on Trigger.new records was proven."],
  };
}

function isTaintedExpression(expression: string, values: Set<string>): boolean {
  const normalized = expression.toLowerCase().replace(/\s+/g, "");
  return [...values].some((value) => normalized === value || normalized.startsWith(`${value}[`) || normalized.startsWith(`${value}.`));
}

function isRecordFieldTarget(target: string, values: Set<string>): boolean {
  const normalized = target.toLowerCase().replace(/\s+/g, "");
  return [...values].some((value) => (normalized.startsWith(`${value}.`) || normalized.startsWith(`${value}[`)) && normalized !== value);
}

function callArguments(detail: string): string[] {
  const open = detail.indexOf("(");
  const close = detail.lastIndexOf(")");
  if (open < 0 || close <= open) return [];
  const value = detail.slice(open + 1, close);
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (value.trim()) result.push(value.slice(start));
  return result.map((item) => item.trim());
}

function ownerOf(symbol: ApexSymbol | undefined, byId: Map<string, ApexSymbol>): ApexSymbol | undefined {
  let current = symbol;
  while (current?.ownerId) current = byId.get(current.ownerId);
  return current;
}
