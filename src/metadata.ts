import { readFile } from "node:fs/promises";
import type { ApexSymbol, RawReference, SourceLocation } from "./model.js";
import { normalizeName } from "./paths.js";

export interface MetadataFileInput {
  absolutePath: string;
  reportPath: string;
}

interface MetadataDocument extends MetadataFileInput {
  source: string;
}

export interface MetadataAnalysis {
  references: RawReference[];
  configuredTypeFields: ReadonlySet<string>;
}

/**
 * Scans every discovered text metadata file. Format-aware extractors provide exact
 * method bindings; the generic pass conservatively catches Apex type names stored
 * in configuration formats the analyzer does not need to understand.
 */
export async function analyzeMetadata(
  files: MetadataFileInput[],
  symbols: ApexSymbol[],
): Promise<MetadataAnalysis> {
  const documents = await mapLimit(files, 16, async (file): Promise<MetadataDocument> => ({
    ...file,
    source: await readFile(file.absolutePath, "utf8"),
  }));
  const knownTypes = new Map(
    symbols
      .filter((symbol) => !symbol.ownerId && symbol.kind !== "trigger" && !symbol.testCode)
      .map((symbol) => [normalizeName(symbol.name), symbol.name]),
  );
  const references = documents.flatMap((document) => [
    ...extractKnownTypeMentions(document, knownTypes),
    ...extractFormatAware(document),
  ]);
  references.push(...extractAuraBundleCalls(documents));
  return {
    references: dedupe(references),
    configuredTypeFields: extractConfiguredTypeFields(documents),
  };
}

function extractConfiguredTypeFields(documents: MetadataDocument[]): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const document of documents) {
    const portable = document.reportPath.replace(/\\/g, "/");
    const recordType = /\/customMetadata\/([^/.]+)\.[^/]+\.md-meta\.xml$/i.exec(portable)?.[1];
    if (!recordType) continue;
    const metadataType = /__mdt$/i.test(recordType) ? recordType : `${recordType}__mdt`;
    for (const values of document.source.matchAll(/<values>([\s\S]*?)<\/values>/gi)) {
      const field = /<field>\s*([A-Za-z_]\w*__c)\s*<\/field>/i.exec(values[1] ?? "")?.[1];
      const hasValue = /<value\b[^>]*>[\s\S]*?<\/value>/i.test(values[1] ?? "");
      if (field && hasValue) fields.add(normalizeName(`${metadataType}.${field}`));
    }
  }
  return fields;
}

function extractFormatAware(document: MetadataDocument): RawReference[] {
  const lowerPath = document.absolutePath.toLowerCase();
  if (lowerPath.endsWith(".js")) return extractLwcImports(document.source, document.reportPath);
  if (lowerPath.endsWith(".cmp") || lowerPath.endsWith(".app")) return extractAuraControllers(document.source, document.reportPath);
  if (lowerPath.endsWith(".page") || lowerPath.endsWith(".component")) return extractVisualforce(document.source, document.reportPath);
  if (lowerPath.endsWith(".flow") || lowerPath.endsWith(".flow-meta.xml")) return extractFlow(document.source, document.reportPath);
  if (lowerPath.endsWith(".md-meta.xml")) return extractCustomMetadata(document.source, document.reportPath);
  return [];
}

function extractAuraControllers(source: string, filePath: string): RawReference[] {
  return collect(source, /\bcontroller\s*=\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']/gi, (match) => ({
    kind: "metadata",
    targetType: match[1],
    testContext: false,
    detail: `Aura Apex controller ${match[1]}`,
  }), filePath);
}

function extractCustomMetadata(source: string, filePath: string): RawReference[] {
  return collect(source, /<value\b[^>]*xsi:type\s*=\s*["']xsd:string["'][^>]*>\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*<\/value>/gi, (match) => ({
    kind: "metadata",
    targetType: match[1],
    testContext: false,
    detail: `Custom Metadata Apex type ${match[1]}`,
  }), filePath);
}

function extractKnownTypeMentions(sourceFile: MetadataDocument, knownTypes: Map<string, string>): RawReference[] {
  const references: RawReference[] = [];
  const exactValues: Array<{ value: string; index: number }> = [];
  const lowerPath = sourceFile.absolutePath.toLowerCase();
  if (/\.(xml|cmp|app|page|component|flow)$/i.test(lowerPath)) {
    collectExactValues(sourceFile.source, /=\s*["']\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*["']/g, exactValues);
    collectExactValues(sourceFile.source, />\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*</g, exactValues);
  } else if (lowerPath.endsWith(".json")) {
    collectExactValues(sourceFile.source, /:\s*["']\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*["']/g, exactValues);
  } else if (/\.(yaml|yml)$/i.test(lowerPath)) {
    collectExactValues(sourceFile.source, /:\s*["']?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*["']?\s*$/gm, exactValues);
  } else if (lowerPath.endsWith(".txt")) {
    collectExactValues(sourceFile.source, /^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*$/gm, exactValues);
  }

  for (const exact of exactValues) {
    const [typeToken, memberName] = exact.value.split(".");
    if (!typeToken) continue;
    const targetType = knownTypes.get(normalizeName(typeToken));
    if (!targetType) continue;
    references.push({
      kind: "metadata",
      targetType,
      ...(memberName ? { memberName } : {}),
      testContext: false,
      location: locationAt(sourceFile.source, sourceFile.reportPath, exact.index),
      detail: `Repository configuration value ${targetType}${memberName ? `.${memberName}` : ""}`,
    });
  }
  return references;
}

function collectExactValues(source: string, pattern: RegExp, values: Array<{ value: string; index: number }>): void {
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value) values.push({ value, index: match.index });
  }
}

function extractAuraBundleCalls(documents: MetadataDocument[]): RawReference[] {
  const bundles = new Map<string, MetadataDocument[]>();
  for (const document of documents) {
    const portable = document.reportPath.replace(/\\/g, "/");
    const match = /^(.*\/aura\/[^/]+)\//i.exec(portable);
    if (!match?.[1]) continue;
    const values = bundles.get(match[1]);
    if (values) values.push(document);
    else bundles.set(match[1], [document]);
  }

  const references: RawReference[] = [];
  for (const documentsInBundle of bundles.values()) {
    const markup = documentsInBundle.filter((document) => /\.(cmp|app)$/i.test(document.reportPath));
    const controllers = markup.flatMap((document) =>
      [...document.source.matchAll(/\bcontroller\s*=\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']/gi)]
        .map((match) => match[1])
        .filter((value): value is string => Boolean(value)),
    );
    if (controllers.length === 0) continue;
    for (const document of documentsInBundle.filter((item) => item.absolutePath.toLowerCase().endsWith(".js"))) {
      for (const match of document.source.matchAll(/\.get\(\s*["']c\.([A-Za-z_]\w*)["']\s*\)/g)) {
        const memberName = match[1];
        if (!memberName) continue;
        for (const targetType of controllers) {
          references.push({
            kind: "metadata",
            targetType,
            memberName,
            testContext: false,
            location: locationAt(document.source, document.reportPath, match.index),
            detail: `Aura bundle call ${targetType}.${memberName}`,
          });
        }
      }
    }
  }
  return references;
}

function extractLwcImports(source: string, filePath: string): RawReference[] {
  return collect(source, /@salesforce\/apex\/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)/g, (match) => ({
    kind: "metadata",
    targetType: match[1],
    memberName: match[2],
    testContext: false,
    detail: `LWC Apex import ${match[1]}.${match[2]}`,
  }), filePath);
}

function extractVisualforce(source: string, filePath: string): RawReference[] {
  const references: RawReference[] = [];
  const controllers: string[] = [];
  for (const match of source.matchAll(/\bcontroller\s*=\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']/gi)) {
    const controller = match[1];
    if (!controller) continue;
    controllers.push(controller);
    references.push(metadataTypeReference(source, filePath, match.index, controller, "Visualforce controller"));
  }
  for (const match of source.matchAll(/\bextensions\s*=\s*["']([^"']+)["']/gi)) {
    for (const extension of (match[1] ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
      controllers.push(extension);
      references.push(metadataTypeReference(source, filePath, match.index, extension, "Visualforce controller extension"));
    }
  }
  for (const match of source.matchAll(/\baction\s*=\s*["']\{!\s*([A-Za-z_]\w*)/gi)) {
    const method = match[1];
    if (!method) continue;
    for (const controller of controllers) {
      references.push({
        kind: "metadata",
        targetType: controller,
        memberName: method,
        testContext: false,
        location: locationAt(source, filePath, match.index),
        detail: `Visualforce action ${controller}.${method}`,
      });
    }
  }
  return references;
}

function extractFlow(source: string, filePath: string): RawReference[] {
  const references: RawReference[] = [];
  for (const match of source.matchAll(/<(?:apexClass|actionName)>\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*<\/(?:apexClass|actionName)>/gi)) {
    const value = match[1];
    if (!value) continue;
    const [targetType, memberName] = value.split(".");
    if (!targetType) continue;
    references.push({
      kind: "metadata",
      targetType,
      ...(memberName ? { memberName } : {}),
      testContext: false,
      location: locationAt(source, filePath, match.index),
      detail: `Flow Apex action ${value}`,
    });
  }
  return references;
}

function collect(
  source: string,
  pattern: RegExp,
  factory: (match: RegExpMatchArray) => Omit<RawReference, "location">,
  filePath: string,
): RawReference[] {
  const result: RawReference[] = [];
  for (const match of source.matchAll(pattern)) {
    result.push({ ...factory(match), location: locationAt(source, filePath, match.index) });
  }
  return result;
}

function metadataTypeReference(
  source: string,
  filePath: string,
  index: number,
  targetType: string,
  detail: string,
): RawReference {
  return {
    kind: "metadata",
    targetType,
    testContext: false,
    location: locationAt(source, filePath, index),
    detail: `${detail} ${targetType}`,
  };
}

function locationAt(source: string, filePath: string, index: number): SourceLocation {
  const prefix = source.slice(0, index);
  const lines = prefix.split(/\r?\n/);
  return { path: filePath, line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function dedupe(references: RawReference[]): RawReference[] {
  return [...new Map(references.map((reference) => [
    [reference.location.path, reference.location.line, reference.targetType, reference.memberName ?? ""].join("|"),
    reference,
  ])).values()];
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
