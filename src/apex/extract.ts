import { readFile } from "node:fs/promises";
import {
  ApexErrorListener,
  ApexParserBaseListener,
  ApexParserFactory,
  ApexParseTreeWalker,
  type AnnotationContext,
  type ClassDeclarationContext,
  type ConstructorDeclarationContext,
  type CreatorContext,
  type DotExpressionContext,
  type DotMethodCallContext,
  type EnhancedForControlContext,
  type EnumDeclarationContext,
  type FieldDeclarationContext,
  type FormalParameterContext,
  type InterfaceDeclarationContext,
  type InterfaceMethodDeclarationContext,
  type LocalVariableDeclarationContext,
  type MethodCallContext,
  type MethodDeclarationContext,
  type ApexParserRuleContext,
  type TriggerUnitContext,
  type TypeRefContext,
} from "@apexdevtools/apex-parser";
import type {
  ApexSymbol,
  AnalysisBlocker,
  EntryPoint,
  ExposureSignal,
  ExtractedFile,
  ParseDiagnostic,
  RawReference,
  SourceLocation,
  SymbolKind,
} from "../model.js";
import { normalizeName, simpleTypeName } from "../paths.js";

const PLATFORM_METHOD_ANNOTATIONS = new Set([
  "auraenabled",
  "invocablemethod",
  "namespaceaccessible",
  "remoteaction",
  "future",
  "httpget",
  "httppost",
  "httpput",
  "httppatch",
  "httpdelete",
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

const BUILTIN_TYPE_NAMES = new Set([
  "blob", "boolean", "date", "datetime", "decimal", "double", "id", "integer", "long", "object",
  "string", "time", "void", "list", "map", "set", "system", "database", "schema", "test", "type",
]);

interface TokenLike {
  line?: number;
  column?: number;
  start?: number;
  stop?: number;
}

interface ContextLike {
  start?: TokenLike | undefined;
  stop?: TokenLike | undefined;
  parentCtx?: ContextLike | undefined;
  getText(): string;
}

interface ModifierContainer extends ContextLike {
  modifier_list(): Array<{ getText(): string }>;
}

interface Scope {
  symbol: ApexSymbol;
  variables: Map<string, string>;
}

class DiagnosticListener extends ApexErrorListener {
  constructor(
    private readonly filePath: string,
    private readonly diagnostics: ParseDiagnostic[],
  ) {
    super();
  }

  apexSyntaxError(line: number, column: number, message: string): void {
    this.diagnostics.push({ path: this.filePath, line, column: column + 1, message });
  }
}

export async function extractApexFile(absolutePath: string, reportPath: string): Promise<ExtractedFile> {
  const source = await readFile(absolutePath, "utf8");
  const diagnostics: ParseDiagnostic[] = [];
  const errorListener = new DiagnosticListener(reportPath, diagnostics);
  const { parser } = ApexParserFactory.createLexerAndParser(source, errorListener);
  const isTrigger = absolutePath.toLowerCase().endsWith(".trigger");
  const tree = isTrigger ? parser.triggerUnit() : parser.compilationUnit();
  const listener = new ExtractionListener(source, reportPath, diagnostics);
  ApexParseTreeWalker.DEFAULT.walk(listener, tree);
  return listener.result();
}

class ExtractionListener extends ApexParserBaseListener {
  private readonly symbols: ApexSymbol[] = [];
  private readonly references: RawReference[] = [];
  private readonly entryPoints: EntryPoint[] = [];
  private readonly blockers: AnalysisBlocker[] = [];
  private readonly exposures: ExposureSignal[] = [];
  private readonly typeStack: Scope[] = [];
  private readonly executableStack: Scope[] = [];

  constructor(
    private readonly source: string,
    private readonly filePath: string,
    private readonly diagnostics: ParseDiagnostic[],
  ) {
    super();
  }

  result(): ExtractedFile {
    return {
      path: this.filePath,
      characters: this.source.length,
      bytes: Buffer.byteLength(this.source, "utf8"),
      symbols: this.symbols,
      references: this.references,
      entryPoints: this.entryPoints,
      blockers: this.blockers,
      exposures: this.exposures,
      diagnostics: this.diagnostics,
    };
  }

  enterTriggerUnit(ctx: TriggerUnitContext): void {
    const name = ctx.id(0).getText();
    const symbol = this.makeTypeSymbol("trigger", name, ctx, [], []);
    this.symbols.push(symbol);
    const scope = { symbol, variables: new Map<string, string>() };
    this.typeStack.push(scope);
    this.executableStack.push(scope);
    this.addEntry(symbol, "platform", "Apex trigger event", false);
  }

  exitTriggerUnit(): void {
    this.executableStack.pop();
    this.typeStack.pop();
  }

  enterClassDeclaration(ctx: ClassDeclarationContext): void {
    const modifiers = modifiersOf(ctx);
    const annotations = annotationsOf(modifiers);
    const interfaces = ctx.typeList()?.typeRef_list().map((type) => type.getText()) ?? [];
    const symbol = this.makeTypeSymbol("class", ctx.id().getText(), ctx, modifiers, interfaces, ctx.typeRef()?.getText());
    this.symbols.push(symbol);
    this.typeStack.push({ symbol, variables: new Map<string, string>() });
    if (annotations.includes("restresource")) {
      this.addExposure(symbol, "annotation", "@RestResource class can be called outside the repository");
    }
    this.addVisibilityExposure(symbol);
  }

  exitClassDeclaration(): void {
    this.typeStack.pop();
  }

  enterInterfaceDeclaration(ctx: InterfaceDeclarationContext): void {
    const modifiers = modifiersOf(ctx);
    const interfaces = ctx.typeList()?.typeRef_list().map((type) => type.getText()) ?? [];
    const symbol = this.makeTypeSymbol("interface", ctx.id().getText(), ctx, modifiers, interfaces);
    this.symbols.push(symbol);
    this.typeStack.push({ symbol, variables: new Map<string, string>() });
    this.addVisibilityExposure(symbol);
  }

  exitInterfaceDeclaration(): void {
    this.typeStack.pop();
  }

  enterEnumDeclaration(ctx: EnumDeclarationContext): void {
    const symbol = this.makeTypeSymbol("enum", ctx.id().getText(), ctx, modifiersOf(ctx), []);
    this.symbols.push(symbol);
    this.typeStack.push({ symbol, variables: new Map<string, string>() });
    this.addVisibilityExposure(symbol);
  }

  exitEnumDeclaration(): void {
    this.typeStack.pop();
  }

  enterMethodDeclaration(ctx: MethodDeclarationContext): void {
    const owner = this.currentType();
    if (!owner) return;
    const modifiers = modifiersOf(ctx);
    const parameterTypes = parameterTypesOf(ctx.formalParameters());
    const symbol = this.makeMemberSymbol("method", owner.symbol, ctx.id().getText(), parameterTypes, ctx, modifiers);
    this.symbols.push(symbol);
    this.executableStack.push({ symbol, variables: new Map<string, string>() });
    this.classifyMethodEntry(symbol, owner.symbol);
    this.addVisibilityExposure(symbol);
  }

  exitMethodDeclaration(): void {
    this.executableStack.pop();
  }

  enterInterfaceMethodDeclaration(ctx: InterfaceMethodDeclarationContext): void {
    const owner = this.currentType();
    if (!owner) return;
    const modifiers = [...modifiersOf(ctx), ...ctx.modifier_list().map((item) => item.getText())];
    const parameterTypes = parameterTypesOf(ctx.formalParameters());
    const symbol = this.makeMemberSymbol("method", owner.symbol, ctx.id().getText(), parameterTypes, ctx, modifiers);
    this.symbols.push(symbol);
    this.addVisibilityExposure(symbol);
  }

  enterConstructorDeclaration(ctx: ConstructorDeclarationContext): void {
    const owner = this.currentType();
    if (!owner) return;
    const parameterTypes = parameterTypesOf(ctx.formalParameters());
    const symbol = this.makeMemberSymbol("constructor", owner.symbol, owner.symbol.name, parameterTypes, ctx, modifiersOf(ctx));
    this.symbols.push(symbol);
    this.executableStack.push({ symbol, variables: new Map<string, string>() });
    this.addVisibilityExposure(symbol);
  }

  exitConstructorDeclaration(): void {
    this.executableStack.pop();
  }

  enterFieldDeclaration(ctx: FieldDeclarationContext): void {
    const scope = this.currentType();
    if (!scope) return;
    const type = ctx.typeRef().getText();
    for (const variable of ctx.variableDeclarators().variableDeclarator_list()) {
      scope.variables.set(normalizeName(variable.id().getText()), type);
    }
  }

  enterFormalParameter(ctx: FormalParameterContext): void {
    const scope = this.currentExecutable();
    if (scope) scope.variables.set(normalizeName(ctx.id().getText()), ctx.typeRef().getText());
  }

  enterLocalVariableDeclaration(ctx: LocalVariableDeclarationContext): void {
    const scope = this.currentExecutable();
    if (!scope) return;
    const type = ctx.typeRef().getText();
    for (const variable of ctx.variableDeclarators().variableDeclarator_list()) {
      scope.variables.set(normalizeName(variable.id().getText()), type);
    }
  }

  enterEnhancedForControl(ctx: EnhancedForControlContext): void {
    this.currentExecutable()?.variables.set(normalizeName(ctx.id().getText()), ctx.typeRef().getText());
  }

  enterMethodCall(ctx: MethodCallContext): void {
    const name = ctx.id()?.getText() ?? ctx.getText().split("(", 1)[0] ?? "";
    this.references.push({
      sourceId: this.currentSourceId(),
      kind: "call",
      memberName: name,
      arity: expressionCount(ctx.expressionList()),
      receiverType: this.currentType()?.symbol.qualifiedName,
      testContext: this.inTestContext(),
      location: this.location(ctx),
      detail: ctx.getText(),
    });
  }

  enterDotMethodCall(ctx: DotMethodCallContext): void {
    const parent = ctx.parentCtx as DotExpressionContext;
    const receiver = parent.expression().getText();
    const name = ctx.anyId().getText();
    const receiverType = this.resolveVariableType(receiver) ?? receiver;
    this.references.push({
      sourceId: this.currentSourceId(),
      kind: "call",
      memberName: name,
      arity: expressionCount(ctx.expressionList()),
      receiver,
      receiverType,
      testContext: this.inTestContext(),
      location: this.location(ctx),
      detail: parent.getText(),
    });

    if (normalizeName(simpleTypeName(receiverType)) === "type" && normalizeName(name) === "forname") {
      const argument = ctx.expressionList()?.getText() ?? "";
      const literal = /^['\"]([A-Za-z_][\w.]*)['\"]$/.exec(argument)?.[1];
      if (literal) {
        this.references.push({
          sourceId: this.currentSourceId(),
          kind: "type",
          targetType: literal,
          testContext: this.inTestContext(),
          location: this.location(ctx),
          detail: `Type.forName literal: ${literal}`,
        });
      } else {
        const sourceId = this.currentSourceId();
        this.blockers.push({
          code: "dynamic-type",
          scope: "reference",
          message: "A computed Type.forName value can reference a class that has no lexical caller.",
          blocksClosedWorldConclusion: true,
          ...(sourceId ? { symbolId: sourceId } : {}),
          location: this.location(ctx),
        });
      }
    }
  }

  enterDotExpression(ctx: DotExpressionContext): void {
    if (ctx.dotMethodCall() || !ctx.anyId()) return;
    const receiver = ctx.expression().getText();
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(receiver)) return;
    const variableType = this.resolveVariableType(receiver);
    this.references.push({
      sourceId: this.currentSourceId(),
      kind: "type",
      targetType: variableType ?? receiver,
      testContext: this.inTestContext(),
      location: this.location(ctx),
      detail: `member access ${ctx.getText()}`,
    });
  }

  enterCreator(ctx: CreatorContext): void {
    if (!ctx.classCreatorRest()) return;
    const typeName = ctx.createdName().getText();
    this.references.push({
      sourceId: this.currentSourceId(),
      kind: "construct",
      targetType: typeName,
      memberName: simpleTypeName(typeName),
      arity: expressionCount(ctx.classCreatorRest().arguments().expressionList()),
      testContext: this.inTestContext(),
      location: this.location(ctx),
      detail: `new ${ctx.getText()}`,
    });
  }

  enterTypeRef(ctx: TypeRefContext): void {
    const typeName = ctx.getText();
    if (BUILTIN_TYPE_NAMES.has(normalizeName(simpleTypeName(typeName)))) return;
    this.references.push({
      sourceId: this.currentSourceId(),
      kind: isInheritanceType(ctx) ? "inheritance" : "type",
      targetType: typeName,
      testContext: this.inTestContext(),
      location: this.location(ctx),
      detail: typeName,
    });
  }

  enterAnnotation(_ctx: AnnotationContext): void {
    // Annotations are captured from declaration modifiers to preserve ownership.
  }

  private makeTypeSymbol(
    kind: Extract<SymbolKind, "class" | "interface" | "enum" | "trigger">,
    name: string,
    ctx: ContextLike,
    modifiers: string[],
    interfaces: string[],
    superclass?: string,
  ): ApexSymbol {
    const parent = this.currentType()?.symbol;
    const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
    const annotations = annotationsOf(modifiers);
    const symbol: ApexSymbol = {
      id: `type:${normalizeName(qualifiedName)}`,
      kind,
      name,
      qualifiedName,
      ...(parent ? { ownerId: parent.id } : {}),
      modifiers: normalizeModifiers(modifiers),
      annotations,
      interfaces,
      ...(superclass ? { superclass } : {}),
      testCode: kind !== "trigger" && (parent?.testCode === true || annotations.includes("istest")),
      location: this.location(ctx),
      sourceCharacters: spanLength(ctx),
      sourceBytes: this.spanBytes(ctx),
    };
    return symbol;
  }

  private makeMemberSymbol(
    kind: "method" | "constructor",
    owner: ApexSymbol,
    name: string,
    parameterTypes: string[],
    ctx: ContextLike,
    modifiers: string[],
  ): ApexSymbol {
    const annotations = annotationsOf(modifiers);
    const signature = parameterTypes.map(normalizeName).join(",");
    return {
      id: `${kind}:${normalizeName(owner.qualifiedName)}.${normalizeName(name)}(${signature})`,
      kind,
      name,
      qualifiedName: `${owner.qualifiedName}.${name}(${parameterTypes.join(", ")})`,
      ownerId: owner.id,
      arity: parameterTypes.length,
      parameterTypes,
      modifiers: normalizeModifiers(modifiers),
      annotations,
      interfaces: [],
      testCode: owner.testCode || annotations.includes("istest") || normalizeModifiers(modifiers).includes("testmethod"),
      location: this.location(ctx),
      sourceCharacters: spanLength(ctx),
      sourceBytes: this.spanBytes(ctx),
    };
  }

  private classifyMethodEntry(symbol: ApexSymbol, owner: ApexSymbol): void {
    if (symbol.testCode) {
      this.addEntry(symbol, "test", "Apex test method", true);
      return;
    }
    const entryAnnotation = symbol.annotations.find((annotation) => PLATFORM_METHOD_ANNOTATIONS.has(annotation));
    if (entryAnnotation) {
      this.addExposure(symbol, "annotation", `@${entryAnnotation} method can be invoked by supported platform or metadata callers`);
    }
    if (symbol.modifiers.includes("webservice")) {
      this.addExposure(symbol, "webservice", "webservice method can be called outside the repository");
    }
    if (symbol.modifiers.includes("global")) {
      this.addExposure(symbol, "visibility", "global method can be called outside the repository");
    }
    for (const implemented of owner.interfaces) {
      const callbacks = PLATFORM_CALLBACKS[normalizeName(simpleTypeName(implemented))];
      if (callbacks?.has(normalizeName(symbol.name))) {
        this.addExposure(symbol, "platform-callback", `${simpleTypeName(implemented)} callback requires a concrete repository caller or metadata binding`);
      }
    }
  }

  private addEntry(symbol: ApexSymbol, source: EntryPoint["source"], reason: string, testOnly: boolean): void {
    this.entryPoints.push({ symbolId: symbol.id, source, reason, testOnly, location: symbol.location });
  }

  private addVisibilityExposure(symbol: ApexSymbol): void {
    if (!symbol.modifiers.some((modifier) => modifier === "public" || modifier === "global" || modifier === "protected")) return;
    this.addExposure(
      symbol,
      "visibility",
      `${symbol.qualifiedName} has ${symbol.modifiers.find((modifier) => modifier === "public" || modifier === "global" || modifier === "protected")} visibility`,
    );
  }

  private addExposure(symbol: ApexSymbol, kind: ExposureSignal["kind"], reason: string): void {
    this.exposures.push({
      kind,
      symbolId: symbol.id,
      reason,
      location: symbol.location,
    });
  }

  private resolveVariableType(receiver: string): string | undefined {
    const normalized = normalizeName(receiver.replace(/^(this|super)\./i, ""));
    const simple = normalized.split(".").at(-1) ?? normalized;
    return this.currentExecutable()?.variables.get(simple) ?? this.currentType()?.variables.get(simple);
  }

  private currentType(): Scope | undefined {
    return this.typeStack.at(-1);
  }

  private currentExecutable(): Scope | undefined {
    return this.executableStack.at(-1);
  }

  private currentSourceId(): string | undefined {
    return this.currentExecutable()?.symbol.id ?? this.currentType()?.symbol.id;
  }

  private inTestContext(): boolean {
    return this.currentExecutable()?.symbol.testCode ?? this.currentType()?.symbol.testCode ?? false;
  }

  private location(ctx: ContextLike): SourceLocation {
    const start = ctx.start;
    const stop = ctx.stop;
    return {
      path: this.filePath,
      line: start?.line ?? 1,
      column: (start?.column ?? 0) + 1,
      ...(stop?.line !== undefined ? { endLine: stop.line } : {}),
      ...(stop?.column !== undefined && stop?.stop !== undefined && stop?.start !== undefined
        ? { endColumn: stop.column + Math.max(1, stop.stop - stop.start + 1) + 1 }
        : {}),
    };
  }

  private spanBytes(ctx: ContextLike): number {
    const start = ctx.start?.start ?? 0;
    const stop = ctx.stop?.stop ?? start - 1;
    return Buffer.byteLength(this.source.slice(start, stop + 1), "utf8");
  }
}

function modifiersOf(ctx: ContextLike): string[] {
  let current = ctx.parentCtx;
  for (let depth = 0; current && depth < 3; depth += 1, current = current.parentCtx) {
    if ("modifier_list" in current && typeof (current as ModifierContainer).modifier_list === "function") {
      return (current as ModifierContainer).modifier_list().map((modifier) => modifier.getText());
    }
  }
  return [];
}

function normalizeModifiers(modifiers: string[]): string[] {
  return modifiers.filter((value) => !value.startsWith("@")).map(normalizeName);
}

function annotationsOf(modifiers: string[]): string[] {
  return modifiers
    .filter((value) => value.startsWith("@"))
    .map((value) => normalizeName(value.slice(1).split("(", 1)[0] ?? value.slice(1)));
}

function parameterTypesOf(ctx: { formalParameterList(): { formalParameter_list(): FormalParameterContext[] } | null }): string[] {
  return ctx.formalParameterList()?.formalParameter_list().map((parameter) => parameter.typeRef().getText()) ?? [];
}

function expressionCount(ctx: { expression_list(): unknown[] } | null): number {
  return ctx?.expression_list().length ?? 0;
}

function spanLength(ctx: ContextLike): number {
  const start = ctx.start?.start ?? 0;
  const stop = ctx.stop?.stop ?? start - 1;
  return Math.max(0, stop - start + 1);
}

function isInheritanceType(ctx: TypeRefContext): boolean {
  let current = ctx.parentCtx as ApexParserRuleContext | undefined;
  for (let depth = 0; current && depth < 3; depth += 1, current = current.parentCtx as ApexParserRuleContext | undefined) {
    const name = current.constructor.name;
    if (name === "ClassDeclarationContext" || name === "InterfaceDeclarationContext" || name === "TypeListContext") return true;
    if (name.includes("Method") || name.includes("Parameter") || name.includes("Variable")) return false;
  }
  return false;
}
