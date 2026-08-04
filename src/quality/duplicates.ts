import { ApexParserFactory, type ApexToken } from "@apexdevtools/apex-parser";
import { REPORT_SCHEMA_VERSION } from "../model.js";
import type {
  ApexSymbol,
  CloneGroup,
  CloneOccurrence,
  DmlFamily,
  DmlObservation,
  DuplicateAnalysis,
  ExecutableBehavior,
  ExtractedFile,
  QueryFamily,
  Reachability,
  SoqlObservation,
} from "../model.js";

const MIN_FRAGMENT_TOKENS = 40;
const MIN_METHOD_TOKENS = 25;
const K_GRAM = 12;
const WINNOW_WINDOW = 6;
const NEAR_MISS_SIMILARITY = 0.85;
const NEAR_MISS_BROAD_SIMILARITY = 0.7;
const NEAR_MISS_BROAD_MIN_TOKENS = 120;

interface CodeToken {
  text: string;
  normalized: string;
  start: number;
  stop: number;
  line: number;
  column: number;
}

interface CodeRegion {
  symbol: ApexSymbol;
  path: string;
  source: string;
  tokens: CodeToken[];
  normalizedTokens: string[];
  exactKey: string;
  normalizedKey: string;
  fingerprints: Fingerprint[];
}

interface Fingerprint {
  hash: number;
  index: number;
}

interface FragmentMatch {
  key: string;
  kind: "exact" | "parameterized";
  occurrences: Array<{ region: CodeRegion; start: number; end: number }>;
}

export function analyzeDuplicates(
  files: ExtractedFile[],
  productionCharacters: number,
  reachability: Record<string, Reachability>,
): DuplicateAnalysis {
  const productionFiles = files.filter((file) => !isTestFile(file));
  const blockedFiles = productionFiles.filter((file) => file.diagnostics.length > 0).map((file) => file.path).sort();
  const tokensByPath = new Map(productionFiles.map((file) => [file.path, lex(file.source)]));
  const productionTokens = [...tokensByPath.values()].reduce((total, tokens) => total + tokens.length, 0);
  const regions = productionFiles.flatMap((file) => buildRegions(file, tokensByPath.get(file.path) ?? []));
  const wholeGroups = buildWholeGroups(regions);
  const wholePairs = new Set(wholeGroups.flatMap((group) => occurrencePairs(group.occurrences.map((item) => item.symbolId))));
  const { nearMissGroups, fragmentGroups } = buildSimilarityGroups(regions, wholePairs);
  const cloneGroups = [...wholeGroups, ...fragmentGroups, ...nearMissGroups]
    .map((group) => prioritizeRepresentative(group, reachability))
    .sort((left, right) => right.duplicatedCharacters - left.duplicatedCharacters || left.id.localeCompare(right.id));
  const coverageIntervals = cloneIntervals(cloneGroups, productionFiles, "coverage");
  const duplicatedIntervals = cloneIntervals(cloneGroups, productionFiles, "redundant");
  const cloneCoverageCharacters = intervalCharacters(coverageIntervals);
  const duplicatedCharacters = [...duplicatedIntervals.values()].flat().reduce((total, [start, end]) => total + end - start + 1, 0);
  const cloneCoverageTokens = intervalTokens(coverageIntervals, productionFiles);
  const duplicatedTokens = intervalTokens(duplicatedIntervals, productionFiles);
  const behaviors = productionFiles.flatMap((file) => file.behaviors);
  const unresolvedDynamicQueries = behaviors.flatMap((behavior) => behavior.dynamicQueryGaps);
  return {
    coverage: {
      status: blockedFiles.length === 0 ? "complete" : "blocked",
      blockedFiles,
      testFilesExcluded: files.length - productionFiles.length,
    },
    productionTokens,
    cloneCoverageTokens,
    cloneCoverageTokenPercent: percent(cloneCoverageTokens, productionTokens),
    cloneCoverageCharacters,
    cloneCoverageCharacterPercent: percent(cloneCoverageCharacters, productionCharacters),
    duplicatedTokens,
    duplicatedTokenPercent: percent(duplicatedTokens, productionTokens),
    duplicatedCharacters,
    duplicatedCharacterPercent: percent(duplicatedCharacters, productionCharacters),
    cloneGroups,
    queryFamilies: buildQueryFamilies(behaviors.flatMap((behavior) => behavior.queries)),
    queryCoverage: {
      status: unresolvedDynamicQueries.length === 0 ? "complete" : "blocked",
      unresolvedDynamicQueries,
    },
    dmlFamilies: buildDmlFamilies(behaviors.flatMap((behavior) => behavior.dml)),
    algorithm: {
      minimumFragmentTokens: MIN_FRAGMENT_TOKENS,
      minimumMethodTokens: MIN_METHOD_TOKENS,
      nearMissSimilarity: NEAR_MISS_SIMILARITY,
      nearMissBroadSimilarity: NEAR_MISS_BROAD_SIMILARITY,
      nearMissBroadMinimumTokens: NEAR_MISS_BROAD_MIN_TOKENS,
      testCodeExcluded: true,
      overlappingIntervalsDeduplicated: true,
    },
  };
}

function buildRegions(file: ExtractedFile, allTokens: CodeToken[]): CodeRegion[] {
  return file.symbols
    .filter((symbol) => !symbol.testCode && (symbol.kind === "method" || symbol.kind === "constructor" || symbol.kind === "trigger"))
    .map((symbol) => {
      const candidates = allTokens.filter((token) => tokenWithinSymbol(token, symbol));
      const firstBrace = candidates.findIndex((token) => token.text === "{");
      let lastBrace = -1;
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (candidates[index]?.text === "}") {
          lastBrace = index;
          break;
        }
      }
      const tokens = firstBrace >= 0 && lastBrace > firstBrace ? candidates.slice(firstBrace + 1, lastBrace) : [];
      const normalized = normalizeParameterized(tokens);
      return {
        symbol,
        path: file.path,
        source: file.source,
        tokens,
        normalizedTokens: normalized,
        exactKey: stableHash(tokens.map((token) => token.text.toLowerCase()).join("\u001f")),
        normalizedKey: stableHash(normalized.join("\u001f")),
        fingerprints: winnow(normalized),
      };
    })
    .filter((region) => region.tokens.length >= MIN_METHOD_TOKENS);
}

function buildWholeGroups(regions: CodeRegion[]): CloneGroup[] {
  const parameterized = groupBy(regions, (region) => region.normalizedKey);
  const result: CloneGroup[] = [];
  for (const group of parameterized.values()) {
    if (group.length < 2) continue;
    const exactKeys = new Set(group.map((region) => region.exactKey));
    const kind = exactKeys.size === 1 ? "exact" as const : "parameterized" as const;
    const occurrences = group.map((region) => occurrence(region, 0, region.tokens.length - 1));
    result.push(makeCloneGroup(kind, 1, occurrences, group[0]?.normalizedKey ?? "", group.map((region) => region.tokens.map((token) => token.text))));
  }
  return result;
}

function buildSimilarityGroups(regions: CodeRegion[], wholePairs: Set<string>): {
  nearMissGroups: CloneGroup[];
  fragmentGroups: CloneGroup[];
} {
  const fingerprintIndex = new Map<number, Array<{ regionIndex: number; tokenIndex: number }>>();
  regions.forEach((region, regionIndex) => {
    for (const fingerprint of region.fingerprints) {
      const values = fingerprintIndex.get(fingerprint.hash);
      const item = { regionIndex, tokenIndex: fingerprint.index };
      if (values) values.push(item);
      else fingerprintIndex.set(fingerprint.hash, [item]);
    }
  });

  const pairSeeds = new Map<string, Array<{ left: number; right: number }>>();
  for (const occurrences of fingerprintIndex.values()) {
    const byRegion = groupBy(occurrences, (item) => String(item.regionIndex));
    const regionIds = [...byRegion.keys()].map(Number).sort((left, right) => left - right);
    if (regionIds.length > 30) continue;
    for (let leftIndex = 0; leftIndex < regionIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < regionIds.length; rightIndex += 1) {
        const leftRegion = regionIds[leftIndex];
        const rightRegion = regionIds[rightIndex];
        if (leftRegion === undefined || rightRegion === undefined) continue;
        const key = `${leftRegion}|${rightRegion}`;
        const seeds = pairSeeds.get(key) ?? [];
        for (const left of byRegion.get(String(leftRegion)) ?? []) {
          for (const right of byRegion.get(String(rightRegion)) ?? []) {
            seeds.push({ left: left.tokenIndex, right: right.tokenIndex });
          }
        }
        pairSeeds.set(key, seeds);
      }
    }
  }

  const nearPairs: Array<[number, number, number]> = [];
  const fragments = new Map<string, FragmentMatch>();
  for (const [pair, seeds] of pairSeeds) {
    if (seeds.length < 2) continue;
    const [leftIndex, rightIndex] = pair.split("|").map(Number);
    const left = regions[leftIndex ?? -1];
    const right = regions[rightIndex ?? -1];
    if (!left || !right || wholePairs.has(symbolPair(left.symbol.id, right.symbol.id))) continue;
    const similarity = sequenceSimilarity(
      left.normalizedTokens,
      right.normalizedTokens,
      dice(new Set(left.fingerprints.map((item) => item.hash)), new Set(right.fingerprints.map((item) => item.hash))),
    );
    if (similarity >= NEAR_MISS_SIMILARITY
      || (Math.min(left.tokens.length, right.tokens.length) >= NEAR_MISS_BROAD_MIN_TOKENS && similarity >= NEAR_MISS_BROAD_SIMILARITY)) {
      nearPairs.push([leftIndex!, rightIndex!, similarity]);
      continue;
    }
    for (const match of maximalContiguousMatches(left, right, seeds)) {
      const leftSlice = normalizeParameterized(left.tokens.slice(match.leftStart, match.leftEnd + 1));
      const key = stableHash(leftSlice.join("\u001f"));
      const exact = tokenTexts(left.tokens, match.leftStart, match.leftEnd) === tokenTexts(right.tokens, match.rightStart, match.rightEnd);
      const existing = fragments.get(key) ?? { key, kind: exact ? "exact" : "parameterized", occurrences: [] };
      if (!exact) existing.kind = "parameterized";
      addFragmentOccurrence(existing, left, match.leftStart, match.leftEnd);
      addFragmentOccurrence(existing, right, match.rightStart, match.rightEnd);
      fragments.set(key, existing);
    }
  }

  const nearMissGroups = connectedNearMissGroups(regions, nearPairs);
  const fragmentGroups = [...fragments.values()]
    .filter((fragment) => fragment.occurrences.length >= 2)
    .map((fragment) => makeCloneGroup(
      fragment.kind,
      1,
      fragment.occurrences.map((item) => occurrence(item.region, item.start, item.end)),
      fragment.key,
      fragment.occurrences.map((item) => item.region.tokens.slice(item.start, item.end + 1).map((token) => token.text)),
    ));
  return { nearMissGroups, fragmentGroups };
}

function connectedNearMissGroups(regions: CodeRegion[], pairs: Array<[number, number, number]>): CloneGroup[] {
  const parent = new Map<number, number>();
  const find = (value: number): number => {
    const current = parent.get(value) ?? value;
    if (current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const [left, right] of pairs) union(left, right);
  const groups = new Map<number, number[]>();
  for (const [left, right] of pairs) {
    for (const value of [left, right]) {
      const root = find(value);
      const values = groups.get(root);
      if (values) {
        if (!values.includes(value)) values.push(value);
      } else groups.set(root, [value]);
    }
  }
  return [...groups.values()].map((indexes) => {
    const relevantPairs = pairs.filter(([left, right]) => indexes.includes(left) && indexes.includes(right));
    const similarity = relevantPairs.reduce((total, pair) => total + pair[2], 0) / relevantPairs.length;
    const occurrences = indexes.map((index) => {
      const region = regions[index]!;
      return occurrence(region, 0, region.tokens.length - 1);
    });
    return makeCloneGroup(
      "near-miss",
      similarity,
      occurrences,
      indexes.map((index) => regions[index]?.normalizedKey).join("|"),
      indexes.map((index) => regions[index]!.normalizedTokens),
    );
  });
}

function makeCloneGroup(
  kind: CloneGroup["kind"],
  similarity: number,
  occurrences: CloneOccurrence[],
  identity: string,
  tokenSequences: string[][],
): CloneGroup {
  const sorted = occurrences.sort(compareOccurrence);
  const canonical = sorted[0];
  const duplicates = sorted.slice(1);
  const duplicatedTokens = duplicates.reduce((total, item) => total + Math.min(item.tokenCount, canonical?.tokenCount ?? item.tokenCount), 0);
  const duplicatedCharacters = duplicates.reduce((total, item) => total + Math.min(item.sourceCharacters, canonical?.sourceCharacters ?? item.sourceCharacters), 0);
  return {
    id: `${kind}-v${REPORT_SCHEMA_VERSION.split(".", 1)[0]}-${stableHash(identity)}`,
    kind,
    profile: kind === "exact" ? "exact-token"
      : kind === "parameterized" ? "identifier-and-literal-parameterized"
        : similarity >= NEAR_MISS_SIMILARITY ? "verified-near-miss-strong" : "verified-near-miss-broad",
    similarity: Math.round(similarity * 10_000) / 10_000,
    duplicatedTokens,
    duplicatedCharacters,
    differences: summarizeDifferences(kind, tokenSequences),
    occurrences: sorted,
  };
}

function summarizeDifferences(kind: CloneGroup["kind"], sequences: string[][]): string[] {
  if (kind === "exact" || sequences.length < 2) return [];
  const representative = sequences[0] ?? [];
  const result: string[] = [];
  for (let sequenceIndex = 1; sequenceIndex < sequences.length; sequenceIndex += 1) {
    const sequence = sequences[sequenceIndex] ?? [];
    if (kind === "near-miss") {
      const lcs = longestCommonSubsequenceLength(representative, sequence);
      result.push(`Compared occurrence: ${representative.length - lcs} representative token deletion(s), ${sequence.length - lcs} insertion(s) under ordered LCS alignment.`);
      continue;
    }
    const examples = new Set<string>();
    for (let index = 0; index < Math.min(representative.length, sequence.length) && examples.size < 12; index += 1) {
      const left = representative[index]!;
      const right = sequence[index]!;
      if (left.toLowerCase() !== right.toLowerCase()) examples.add(`${left} <> ${right}`);
    }
    result.push(`Compared occurrence: ${examples.size} shown identifier/literal difference(s): ${[...examples].join(", ") || "none"}.`);
  }
  return result;
}

function prioritizeRepresentative(group: CloneGroup, reachability: Record<string, Reachability>): CloneGroup {
  const occurrences = [...group.occurrences].sort((left, right) => {
    const leftRank = reachability[left.symbolId] === "production" ? 0 : reachability[left.symbolId] === "test-only" ? 2 : 1;
    const rightRank = reachability[right.symbolId] === "production" ? 0 : reachability[right.symbolId] === "test-only" ? 2 : 1;
    return leftRank - rightRank || right.sourceCharacters - left.sourceCharacters || compareOccurrence(left, right);
  });
  const canonical = occurrences[0];
  const duplicates = occurrences.slice(1);
  return {
    ...group,
    occurrences,
    duplicatedTokens: duplicates.reduce((total, item) => total + Math.min(item.tokenCount, canonical?.tokenCount ?? item.tokenCount), 0),
    duplicatedCharacters: duplicates.reduce((total, item) => total + Math.min(item.sourceCharacters, canonical?.sourceCharacters ?? item.sourceCharacters), 0),
  };
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  if (left.length * right.length > 2_000_000) return Math.min(left.length, right.length, Math.round(((left.length + right.length) * sequenceFingerprintSimilarity(left, right)) / 2));
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = left[leftIndex - 1]?.toLowerCase() === right[rightIndex - 1]?.toLowerCase()
        ? previous[rightIndex - 1]! + 1
        : Math.max(previous[rightIndex]!, current[rightIndex - 1]!);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[right.length]!;
}

function sequenceFingerprintSimilarity(left: string[], right: string[]): number {
  return dice(new Set(winnow(left).map((item) => item.hash)), new Set(winnow(right).map((item) => item.hash)));
}

function occurrence(region: CodeRegion, start: number, end: number): CloneOccurrence {
  const first = region.tokens[start]!;
  const last = region.tokens[end]!;
  return {
    symbolId: region.symbol.id,
    path: region.path,
    startLine: first.line,
    endLine: last.line,
    startColumn: first.column + 1,
    endColumn: last.column + Math.max(1, last.stop - last.start + 1) + 1,
    tokenCount: end - start + 1,
    sourceCharacters: last.stop - first.start + 1,
  };
}

function cloneIntervals(
  groups: CloneGroup[],
  files: ExtractedFile[],
  mode: "coverage" | "redundant",
): Map<string, Array<[number, number]>> {
  const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
  const raw = new Map<string, Array<[number, number]>>();
  for (const group of groups) {
    for (const item of mode === "coverage" ? group.occurrences : group.occurrences.slice(1)) {
      const start = sourceOffset(sourceByPath.get(item.path) ?? "", item.startLine, item.startColumn);
      const end = start + item.sourceCharacters - 1;
      const values = raw.get(item.path);
      if (values) values.push([start, end]);
      else raw.set(item.path, [[start, end]]);
    }
  }
  return new Map([...raw].map(([path, intervals]) => [path, mergeIntervals(intervals)]));
}

function intervalCharacters(intervals: Map<string, Array<[number, number]>>): number {
  return [...intervals.values()].flat().reduce((total, [start, end]) => total + end - start + 1, 0);
}

function intervalTokens(intervals: Map<string, Array<[number, number]>>, files: ExtractedFile[]): number {
  const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
  return [...intervals].reduce((total, [path, fileIntervals]) => {
    const source = sourceByPath.get(path) ?? "";
    return total + fileIntervals.reduce((fileTotal, [start, end]) => fileTotal + lex(source.slice(start, end + 1)).length, 0);
  }, 0);
}

function buildQueryFamilies(observations: SoqlObservation[]): QueryFamily[] {
  const result: QueryFamily[] = [];
  for (const [object, queries] of groupBy(observations, (query) => query.object.toLowerCase())) {
    if (queries.length < 2 || new Set(queries.map((query) => query.symbolId)).size < 2) continue;
    const exactGroups = groupBy(queries, (query) => query.normalizedQuery);
    for (const [normalized, exact] of exactGroups) {
      if (exact.length < 2) continue;
      result.push(makeQueryFamily(object, "exact-query", exact, normalized));
    }
    const distinct = [...new Map(queries.map((query) => [query.normalizedQuery, query])).values()];
    if (distinct.length < 2) continue;
    const connected = connectedQueries(distinct);
    for (const family of connected.filter((items) => items.length >= 2)) {
      result.push(makeQueryFamily(object, "selector-family", family, family.map((query) => query.normalizedQuery).join("|")));
    }
  }
  return result.sort((left, right) => right.occurrences.length - left.occurrences.length || left.id.localeCompare(right.id));
}

function makeQueryFamily(object: string, kind: QueryFamily["kind"], queries: SoqlObservation[], identity: string): QueryFamily {
  const fieldSets = queries.map((query) => new Set(query.fields.map((field) => field.toLowerCase())));
  const common = fieldSets.slice(1).reduce((current, fields) => new Set([...current].filter((field) => fields.has(field))), fieldSets[0] ?? new Set<string>());
  const union = new Set(fieldSets.flatMap((fields) => [...fields]));
  return {
    id: `query-v${REPORT_SCHEMA_VERSION.split(".", 1)[0]}-${stableHash(`${object}|${identity}`)}`,
    object,
    kind,
    commonFields: [...common].sort(),
    unionFields: [...union].sort(),
    filterShapes: [...new Set(queries.map((query) => query.filterShape))].sort(),
    occurrences: queries.sort((left, right) => compareLocation(left.location, right.location)),
    recommendation: kind === "exact-query"
      ? `Centralize the repeated ${object} query behind one selector method.`
      : `Review a selector for ${object} with reusable field sets and filter-specific methods.`,
  };
}

function connectedQueries(queries: SoqlObservation[]): SoqlObservation[][] {
  const remaining = new Set(queries.map((_, index) => index));
  const groups: SoqlObservation[][] = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as number;
    remaining.delete(seed);
    const queue = [seed];
    const group: SoqlObservation[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const query = queries[current]!;
      group.push(query);
      for (const candidate of [...remaining]) {
        const other = queries[candidate]!;
        if (querySemanticKey(query) === querySemanticKey(other)
          && (query.filterShape === other.filterShape || jaccard(new Set(query.fields.map((field) => field.toLowerCase())), new Set(other.fields.map((field) => field.toLowerCase()))) >= 0.5)) {
          remaining.delete(candidate);
          queue.push(candidate);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function buildDmlFamilies(observations: DmlObservation[]): DmlFamily[] {
  return [...groupBy(
    observations.filter((item): item is DmlObservation & { targetType: string } => Boolean(item.targetType)),
    (item) => `${item.operation}|${item.targetType.toLowerCase()}|${item.allOrNone}|${item.accessMode}`,
  )]
    .filter(([, items]) => items.length >= 2 && new Set(items.map((item) => item.symbolId)).size >= 2)
    .map(([key, items]) => ({
      id: `dml-v${REPORT_SCHEMA_VERSION.split(".", 1)[0]}-${stableHash(key)}`,
      operation: items[0]!.operation,
      targetType: items[0]!.targetType,
      occurrences: items.sort((left, right) => compareLocation(left.location, right.location)),
      recommendation: `Review a shared ${items[0]!.targetType} domain/data operation for repeated ${items[0]!.operation} behavior.`,
    }));
}

function querySemanticKey(query: SoqlObservation): string {
  return [query.object.toLowerCase(), query.securityMode, query.sharingContext, query.aggregate, query.locking].join("|");
}

function lex(source: string): CodeToken[] {
  const lexer = ApexParserFactory.createLexer(source);
  const stream = ApexParserFactory.createTokenStream(lexer);
  stream.fill();
  return (stream.tokens as ApexToken[])
    .filter((token) => token.channel === 0 && token.type !== -1 && token.text !== undefined && token.start >= 0 && token.stop >= token.start)
    .map((token) => ({
      text: token.text!,
      normalized: normalizeToken(token.text!, lexer.symbolicNames?.[token.type] ?? undefined),
      start: token.start,
      stop: token.stop,
      line: token.line,
      column: token.column,
    }));
}

function normalizeParameterized(tokens: CodeToken[]): string[] {
  const identifiers = new Map<string, string>();
  let cursor = 0;
  return tokens.map((token, index) => {
    if (token.normalized !== "<identifier>") return token.normalized;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    // Keep declared type identity: merging a type with a same-spelled local
    // (for example `Opportunity opportunity`) corrupts alpha-renaming.
    if (isTypeIdentifier(previous, next)) return `<type:${token.text.toLowerCase()}>`;
    const namespace = previous?.text === "." ? "member" : "value";
    const key = `${namespace}:${token.text.toLowerCase()}`;
    const existing = identifiers.get(key);
    if (existing) return existing;
    const value = `<id:${cursor++}>`;
    identifiers.set(key, value);
    return value;
  });
}

function isTypeIdentifier(previous: CodeToken | undefined, next: CodeToken | undefined): boolean {
  if (next?.normalized === "<identifier>" && previous?.text !== ".") return true;
  if (previous && ["new", "extends", "implements", "instanceof"].includes(previous.text.toLowerCase())) return true;
  return false;
}

function normalizeToken(text: string, symbolicName?: string): string {
  if (symbolicName === "Identifier") return "<identifier>";
  if (symbolicName?.endsWith("Literal")) return `<${symbolicName.toLowerCase()}>`;
  return text.toLowerCase();
}

function winnow(tokens: string[]): Fingerprint[] {
  if (tokens.length < K_GRAM) return [];
  const hashes = Array.from({ length: tokens.length - K_GRAM + 1 }, (_, index) => ({
    hash: hash32(tokens.slice(index, index + K_GRAM).join("\u001f")),
    index,
  }));
  if (hashes.length <= WINNOW_WINDOW) return [hashes.reduce((best, item) => item.hash <= best.hash ? item : best)];
  const result: Fingerprint[] = [];
  let lastIndex = -1;
  for (let index = 0; index <= hashes.length - WINNOW_WINDOW; index += 1) {
    const minimum = hashes.slice(index, index + WINNOW_WINDOW).reduce((best, item) => item.hash <= best.hash ? item : best);
    if (minimum.index !== lastIndex) {
      result.push(minimum);
      lastIndex = minimum.index;
    }
  }
  return result;
}

function maximalContiguousMatches(left: CodeRegion, right: CodeRegion, seeds: Array<{ left: number; right: number }>): Array<{
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
  length: number;
}> {
  const leftTokens = left.normalizedTokens;
  const rightTokens = right.normalizedTokens;
  const candidates = new Map<string, { leftStart: number; leftEnd: number; rightStart: number; rightEnd: number; length: number }>();
  for (const seed of seeds.slice(0, 500)) {
    if (!equalSlice(leftTokens, seed.left, rightTokens, seed.right, K_GRAM)) continue;
    let leftStart = seed.left;
    let rightStart = seed.right;
    let leftEnd = seed.left + K_GRAM - 1;
    let rightEnd = seed.right + K_GRAM - 1;
    while (leftStart > 0 && rightStart > 0 && leftTokens[leftStart - 1] === rightTokens[rightStart - 1]) {
      leftStart -= 1;
      rightStart -= 1;
    }
    while (leftEnd + 1 < leftTokens.length && rightEnd + 1 < rightTokens.length && leftTokens[leftEnd + 1] === rightTokens[rightEnd + 1]) {
      leftEnd += 1;
      rightEnd += 1;
    }
    const length = leftEnd - leftStart + 1;
    if (length >= MIN_FRAGMENT_TOKENS) candidates.set(`${leftStart}:${leftEnd}:${rightStart}:${rightEnd}`, { leftStart, leftEnd, rightStart, rightEnd, length });
  }
  const selected: Array<{ leftStart: number; leftEnd: number; rightStart: number; rightEnd: number; length: number }> = [];
  for (const candidate of [...candidates.values()].sort((a, b) => b.length - a.length || a.leftStart - b.leftStart || a.rightStart - b.rightStart)) {
    if (selected.some((item) => intervalsOverlap(item.leftStart, item.leftEnd, candidate.leftStart, candidate.leftEnd)
      || intervalsOverlap(item.rightStart, item.rightEnd, candidate.rightStart, candidate.rightEnd))) continue;
    selected.push(candidate);
    if (selected.length >= 50) break;
  }
  return selected;
}

function intervalsOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function tokenWithinSymbol(token: CodeToken, symbol: ApexSymbol): boolean {
  const endLine = symbol.location.endLine ?? symbol.location.line;
  const endColumn = symbol.location.endColumn ?? Number.MAX_SAFE_INTEGER;
  if (token.line < symbol.location.line || token.line > endLine) return false;
  if (token.line === symbol.location.line && token.column + 1 < symbol.location.column) return false;
  return token.line !== endLine || token.column + 1 <= endColumn;
}

function addFragmentOccurrence(fragment: FragmentMatch, region: CodeRegion, start: number, end: number): void {
  if (!fragment.occurrences.some((item) => item.region.symbol.id === region.symbol.id && item.start === start && item.end === end)) {
    fragment.occurrences.push({ region, start, end });
  }
}

function tokenTexts(tokens: CodeToken[], start: number, end: number): string {
  return tokens.slice(start, end + 1).map((token) => token.text.toLowerCase()).join("\u001f");
}

function equalSlice(left: string[], leftStart: number, right: string[], rightStart: number, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (left[leftStart + index] !== right[rightStart + index]) return false;
  }
  return true;
}

function occurrencePairs(ids: string[]): string[] {
  const result: string[] = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      if (ids[left] && ids[right]) result.push(symbolPair(ids[left]!, ids[right]!));
    }
  }
  return result;
}

function symbolPair(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.sort((left, right) => left[0] - right[0]);
  const result: Array<[number, number]> = [];
  for (const interval of sorted) {
    const last = result.at(-1);
    if (!last || interval[0] > last[1] + 1) result.push([...interval]);
    else last[1] = Math.max(last[1], interval[1]);
  }
  return result;
}

function sourceOffset(source: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return source.length;
    offset = newline + 1;
  }
  return Math.min(source.length, offset + Math.max(0, column - 1));
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const current = result.get(key(value));
    if (current) current.push(value);
    else result.set(key(value), [value]);
  }
  return result;
}

function dice(left: Set<number>, right: Set<number>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

function sequenceSimilarity(left: string[], right: string[], fallback: number): number {
  if (left.length === 0 && right.length === 0) return 1;
  // Exact LCS verification is robust to inserted/deleted statements. Bound the
  // matrix for enterprise methods; winnowing remains the deterministic fallback.
  if (left.length * right.length > 2_000_000) return fallback;
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? previous[rightIndex - 1]! + 1
        : Math.max(previous[rightIndex]!, current[rightIndex - 1]!);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return (2 * previous[right.length]!) / (left.length + right.length);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

function stableHash(value: string): string {
  return hash32(value).toString(16).padStart(8, "0");
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 10_000) / 100;
}

function compareOccurrence(left: CloneOccurrence, right: CloneOccurrence): number {
  return left.path.localeCompare(right.path) || left.startLine - right.startLine || left.startColumn - right.startColumn;
}

function compareLocation(left: { path: string; line: number; column: number }, right: { path: string; line: number; column: number }): number {
  return left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column;
}

function isTestFile(file: ExtractedFile): boolean {
  return file.symbols.find((symbol) => !symbol.ownerId)?.testCode === true;
}
