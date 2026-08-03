import { readFile } from "node:fs/promises";
import type { RawReference, SourceLocation } from "./model.js";

export async function extractMetadataReferences(absolutePath: string, reportPath: string): Promise<RawReference[]> {
  const source = await readFile(absolutePath, "utf8");
  const lowerPath = absolutePath.toLowerCase();
  if (lowerPath.endsWith(".js")) return extractLwcImports(source, reportPath);
  if (lowerPath.endsWith(".page") || lowerPath.endsWith(".component")) return extractVisualforce(source, reportPath);
  if (lowerPath.endsWith(".cmp") || lowerPath.endsWith(".app")) return extractAura(source, reportPath);
  if (lowerPath.endsWith(".flow") || lowerPath.endsWith(".flow-meta.xml")) return extractFlow(source, reportPath);
  if (lowerPath.endsWith(".md-meta.xml")) return extractCustomMetadata(source, reportPath);
  return [];
}

function extractCustomMetadata(source: string, filePath: string): RawReference[] {
  return collect(source, /<value\b[^>]*xsi:type\s*=\s*["']xsd:string["'][^>]*>\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*<\/value>/gi, (match) => ({
    kind: "metadata",
    targetType: match[1],
    testContext: false,
    detail: `Custom Metadata string matching Apex type ${match[1]}`,
  }), filePath);
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

function extractAura(source: string, filePath: string): RawReference[] {
  return collect(source, /\bcontroller\s*=\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']/gi, (match) => ({
    kind: "metadata",
    targetType: match[1],
    testContext: false,
    detail: `Aura Apex controller ${match[1]}`,
  }), filePath);
}

function extractFlow(source: string, filePath: string): RawReference[] {
  const references: RawReference[] = [];
  for (const match of source.matchAll(/<(?:apexClass|actionName)>\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*<\/(?:apexClass|actionName)>/gi)) {
    const type = match[1];
    if (!type || type.includes(".")) continue;
    references.push(metadataTypeReference(source, filePath, match.index, type, "Flow Apex action"));
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
