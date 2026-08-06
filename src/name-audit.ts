import type {
  ExtractedFile,
  NameReferenceOccurrence,
  RawReference,
  SourceLocation,
  TopLevelClassNameAudit,
  TopLevelClassNameAuditEntry,
} from "./model.js";
import { normalizeName, simpleTypeName } from "./paths.js";

const REFERENCE_PATTERNS = [
  "ClassName.member",
  "new ClassName(...)",
  "Type.forName('ClassName')",
  "metadata exact Apex bindings",
];

interface ClassFile {
  name: string;
  path: string;
  source: string;
  testCode: boolean;
  sourceCharacters: number;
  sourceBytes: number;
}

export function auditTopLevelClassNames(
  apexFiles: ExtractedFile[],
  metadataReferences: RawReference[],
  productionApexCharacters: number,
): TopLevelClassNameAudit {
  const classes = apexFiles
    .filter((file) => /\.cls$/i.test(file.path))
    .map(classFileFromApexFile);
  const productionClasses = classes.filter((item) => !item.testCode);
  const referencesByName = new Map<string, NameReferenceOccurrence[]>();

  for (const target of productionClasses) {
    const references: NameReferenceOccurrence[] = [];
    for (const source of apexFiles.filter((file) => isProductionCaller(file) && file.path !== target.path)) {
      references.push(...findApexNameReferences(source.source, source.path, target.name));
    }
    references.push(...findMetadataNameReferences(metadataReferences, target.name));
    referencesByName.set(normalizeName(target.name), dedupeReferences(references));
  }

  const entries: TopLevelClassNameAuditEntry[] = classes
    .map((file) => {
      const references = referencesByName.get(normalizeName(file.name)) ?? [];
      return {
        name: file.name,
        path: file.path,
        testCode: file.testCode,
        sourceCharacters: file.sourceCharacters,
        sourceBytes: file.sourceBytes,
        referencedByName: file.testCode || references.length > 0,
        referenceCount: references.length,
        references,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const unreferencedProduction = entries.filter((entry) => !entry.testCode && !entry.referencedByName);
  const unreferencedProductionCharacters = unreferencedProduction
    .reduce((total, entry) => total + entry.sourceCharacters, 0);

  return {
    productionClasses: productionClasses.length,
    testClasses: classes.length - productionClasses.length,
    referencedProductionClasses: productionClasses.length - unreferencedProduction.length,
    unreferencedProductionClasses: unreferencedProduction.length,
    unreferencedProductionCharacters,
    unreferencedProductionPercent: percent(unreferencedProductionCharacters, productionApexCharacters),
    referencePatterns: REFERENCE_PATTERNS,
    entries,
  };
}

function classFileFromApexFile(file: ExtractedFile): ClassFile {
  const fileName = file.path.split(/[\\/]/).at(-1) ?? file.path;
  const name = fileName.replace(/\.cls$/i, "");
  const topLevel = file.symbols.find((symbol) =>
    !symbol.ownerId && symbol.kind === "class" && normalizeName(symbol.name) === normalizeName(name),
  ) ?? file.symbols.find((symbol) => !symbol.ownerId && symbol.kind === "class");
  return {
    name,
    path: file.path,
    source: file.source,
    testCode: topLevel?.testCode ?? hasTopLevelIsTestAnnotation(file.source, name),
    sourceCharacters: file.characters,
    sourceBytes: file.bytes,
  };
}

function isProductionCaller(file: ExtractedFile): boolean {
  if (/\.trigger$/i.test(file.path)) return true;
  if (!/\.cls$/i.test(file.path)) return false;
  const classFile = classFileFromApexFile(file);
  return !classFile.testCode;
}

function findApexNameReferences(source: string, path: string, targetName: string): NameReferenceOccurrence[] {
  const references: NameReferenceOccurrence[] = [];
  const code = maskCommentsAndStrings(source);
  collectPattern(code, path, new RegExp(`\\b${escapeRegExp(targetName)}\\s*\\.`, "gi"), "apex-static-member", `${targetName}.member`, references);
  collectPattern(code, path, new RegExp(`\\bnew\\s+${escapeRegExp(targetName)}\\s*\\(`, "gi"), "apex-constructor", `new ${targetName}(...)`, references);

  const codeWithStrings = maskComments(source);
  collectPattern(
    codeWithStrings,
    path,
    new RegExp(`\\bType\\s*\\.\\s*forName\\s*\\(\\s*['"]${escapeRegExp(targetName)}['"]`, "gi"),
    "apex-type-literal",
    `Type.forName('${targetName}')`,
    references,
  );
  return dedupeReferences(references);
}

function findMetadataNameReferences(metadataReferences: RawReference[], targetName: string): NameReferenceOccurrence[] {
  const normalized = normalizeName(targetName);
  return metadataReferences
    .filter((reference) => reference.targetType && normalizeName(simpleTypeName(reference.targetType)) === normalized)
    .map((reference) => ({
      ...reference.location,
      kind: "metadata" as const,
      detail: reference.detail,
    }));
}

function collectPattern(
  source: string,
  path: string,
  pattern: RegExp,
  kind: NameReferenceOccurrence["kind"],
  detail: string,
  output: NameReferenceOccurrence[],
): void {
  for (const match of source.matchAll(pattern)) {
    output.push({ ...locationAt(source, path, match.index), kind, detail });
  }
}

function maskCommentsAndStrings(source: string): string {
  return maskComments(source).replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"/g, (value) => preserveNewlines(value));
}

function maskComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (value) => preserveNewlines(value))
    .replace(/\/\/[^\r\n]*/g, (value) => preserveNewlines(value));
}

function preserveNewlines(value: string): string {
  return value.replace(/[^\r\n]/g, " ");
}

function hasTopLevelIsTestAnnotation(source: string, className: string): boolean {
  const classPattern = new RegExp(`@\\s*isTest\\b[\\s\\S]{0,500}?\\bclass\\s+${escapeRegExp(className)}\\b`, "i");
  return classPattern.test(maskComments(source));
}

function locationAt(source: string, path: string, index: number | undefined): SourceLocation {
  const prefix = source.slice(0, index ?? 0);
  const lines = prefix.split(/\r?\n/);
  return { path, line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function dedupeReferences(references: NameReferenceOccurrence[]): NameReferenceOccurrence[] {
  return [...new Map(references.map((reference) => [
    `${reference.path}|${reference.line}|${reference.column}|${reference.kind}`,
    reference,
  ])).values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column,
  );
}

function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 10_000) / 100;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
