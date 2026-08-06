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
  type DeleteStatementContext,
  type DoWhileStatementContext,
  type EnhancedForControlContext,
  type EnumDeclarationContext,
  type ExpressionStatementContext,
  type FieldDeclarationContext,
  type ForStatementContext,
  type FormalParameterContext,
  type IfStatementContext,
  type InterfaceDeclarationContext,
  type InterfaceMethodDeclarationContext,
  type InsertStatementContext,
  type LocalVariableDeclarationContext,
  type MethodCallContext,
  type MethodDeclarationContext,
  type MergeStatementContext,
  type ApexParserRuleContext,
  type QueryContext,
  type ReturnStatementContext,
  type StatementContext,
  type SwitchStatementContext,
  type ThrowStatementContext,
  type TriggerUnitContext,
  type TryStatementContext,
  type TypeRefContext,
  type UndeleteStatementContext,
  type UpdateStatementContext,
  type UpsertStatementContext,
  type WhileStatementContext,
} from "@apexdevtools/apex-parser";
import type {
  ApexSymbol,
  AnalysisBlocker,
  DmlObservation,
  EntryPoint,
  ExecutableBehavior,
  ExposureSignal,
  ExtractedFile,
  ParseDiagnostic,
  RawReference,
  SoqlObservation,
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
  strings: Map<string, string>;
  repositoryMetadataVariables: Map<string, string>;
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
  private readonly behaviors: ExecutableBehavior[] = [];
  private readonly typeStack: Scope[] = [];
  private readonly executableStack: Scope[] = [];
  private readonly behaviorStack: ExecutableBehavior[] = [];
  private controlDepth = 0;

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
      source: this.source,
      characters: this.source.length,
      bytes: Buffer.byteLength(this.source, "utf8"),
      symbols: this.symbols,
      references: this.references,
      entryPoints: this.entryPoints,
      blockers: this.blockers,
      exposures: this.exposures,
      behaviors: this.behaviors,
      diagnostics: this.diagnostics,
    };
  }

  enterTriggerUnit(ctx: TriggerUnitContext): void {
    const name = ctx.id(0).getText();
    const symbol = this.makeTypeSymbol("trigger", name, ctx, [], []);
    this.symbols.push(symbol);
    const scope = { symbol, variables: new Map<string, string>(), strings: new Map<string, string>(), repositoryMetadataVariables: new Map<string, string>() };
    this.typeStack.push(scope);
    this.executableStack.push(scope);
    this.behaviorStack.push(newBehavior(symbol.id));
    this.addEntry(symbol, "platform", "Apex trigger event", false);
  }

  exitTriggerUnit(): void {
    this.finishBehavior();
    this.executableStack.pop();
    this.typeStack.pop();
  }

  enterClassDeclaration(ctx: ClassDeclarationContext): void {
    const modifiers = modifiersOf(ctx);
    const annotations = annotationsOf(modifiers);
    const interfaces = ctx.typeList()?.typeRef_list().map((type) => type.getText()) ?? [];
    const symbol = this.makeTypeSymbol("class", ctx.id().getText(), ctx, modifiers, interfaces, ctx.typeRef()?.getText());
    this.symbols.push(symbol);
    this.typeStack.push({ symbol, variables: new Map<string, string>(), strings: new Map<string, string>(), repositoryMetadataVariables: new Map<string, string>() });
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
    this.typeStack.push({ symbol, variables: new Map<string, string>(), strings: new Map<string, string>(), repositoryMetadataVariables: new Map<string, string>() });
    this.addVisibilityExposure(symbol);
  }

  exitInterfaceDeclaration(): void {
    this.typeStack.pop();
  }

  enterEnumDeclaration(ctx: EnumDeclarationContext): void {
    const symbol = this.makeTypeSymbol("enum", ctx.id().getText(), ctx, modifiersOf(ctx), []);
    this.symbols.push(symbol);
    this.typeStack.push({ symbol, variables: new Map<string, string>(), strings: new Map<string, string>(), repositoryMetadataVariables: new Map<string, string>() });
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
    const symbol = this.makeMemberSymbol("method", owner.symbol, ctx.id().getText(), parameterTypes, ctx, modifiers, parameterNamesOf(ctx.formalParameters()));
    this.symbols.push(symbol);
    this.executableStack.push({ symbol, variables: new Map<string, string>(), strings: new Map<string, string>(), repositoryMetadataVariables: new Map<string, string>() });
    this.behaviorStack.push(newBehavior(symbol.id));
    this.classifyMethodEntry(symbol, owner.symbol);
    this.addVisibilityExposure(symbol);
  }

  exitMethodDeclaration(): void {
    this.finishBehavior();
    this.executableStack.pop();
  }

  enterInterfaceMethodDeclaration(ctx: InterfaceMethodDeclarationContext): void {
    const owner = this.currentType();
    if (!owner) return;
    const modifiers = [...modifiersOf(ctx), ...ctx.modifier_list().map((item) => item.getText())];
    const parameterTypes = parameterTypesOf(ctx.formalParameters());
    const symbol = this.makeMemberSymbol("method", owner.symbol, ctx.id().getText(), parameterTypes, ctx, modifiers, parameterNamesOf(ctx.formalParameters()));
    this.symbols.push(symbol);
    this.addVisibilityExposure(symbol);
  }

  enterConstructorDeclaration(ctx: ConstructorDeclarationContext): void {
    const owner = this.currentType();
    if (!owner) return;
    const parameterTypes = parameterTypesOf(ctx.formalParameters());
    const symbol = this.makeMemberSymbol("constructor", owner.symbol, owner.symbol.name, parameterTypes, ctx, modifiersOf(ctx), parameterNamesOf(ctx.formalParameters()));
    this.symbols.push(symbol);
    this.executableStack.push({ symbol, variables: new Map<string, string>(), strings: new Map<string, string>(), repositoryMetadataVariables: new Map<string, string>() });
    this.behaviorStack.push(newBehavior(symbol.id));
    this.addVisibilityExposure(symbol);
  }

  exitConstructorDeclaration(): void {
    this.finishBehavior();
    this.executableStack.pop();
  }

  enterFieldDeclaration(ctx: FieldDeclarationContext): void {
    const scope = this.currentType();
    if (!scope) return;
    const type = ctx.typeRef().getText();
    for (const variable of ctx.variableDeclarators().variableDeclarator_list()) {
      const name = normalizeName(variable.id().getText());
      scope.variables.set(name, type);
      if (variable.ASSIGN()) {
        this.currentBehavior()?.valueBindings.push({
          name,
          type,
          expression: variable.expression().getText(),
          conditional: this.controlDepth > 0,
          location: this.location(variable),
        });
      }
      if (normalizeName(type) === "string" && isFinalField(ctx) && variable.ASSIGN()) {
        const value = foldApexString(variable.expression().getText(), (identifier) => this.resolveStringValue(identifier));
        if (value !== undefined) scope.strings.set(name, value);
      }
    }
  }

  enterFormalParameter(ctx: FormalParameterContext): void {
    const scope = this.currentExecutable();
    if (scope) scope.variables.set(normalizeName(ctx.id().getText()), ctx.typeRef().getText());
    this.recordAdvancedCollection(ctx.typeRef().getText());
  }

  enterLocalVariableDeclaration(ctx: LocalVariableDeclarationContext): void {
    const scope = this.currentExecutable();
    if (!scope) return;
    const type = ctx.typeRef().getText();
    this.recordAdvancedCollection(type);
    for (const variable of ctx.variableDeclarators().variableDeclarator_list()) {
      const name = normalizeName(variable.id().getText());
      scope.variables.set(name, type);
      if (normalizeName(type) === "string" && variable.ASSIGN()) {
        const value = foldApexString(variable.expression().getText(), (identifier) => this.resolveStringValue(identifier));
        if (value !== undefined) scope.strings.set(name, value);
      }
      if (variable.ASSIGN()) {
        const expression = variable.expression().getText();
        this.currentBehavior()?.valueBindings.push({
          name,
          type,
          expression,
          conditional: this.controlDepth > 0,
          location: this.location(variable),
        });
        const metadataType = repositoryMetadataExpressionType(type, expression);
        if (metadataType) scope.repositoryMetadataVariables.set(name, metadataType);
      }
    }
  }

  enterEnhancedForControl(ctx: EnhancedForControlContext): void {
    this.currentExecutable()?.variables.set(normalizeName(ctx.id().getText()), ctx.typeRef().getText());
    this.currentBehavior()?.enhancedForLoops.push({ variable: ctx.id().getText(), collection: ctx.expression().getText() });
  }

  enterStatement(_ctx: StatementContext): void {
    const behavior = this.currentBehavior();
    if (behavior) behavior.statements += 1;
  }

  enterIfStatement(_ctx: IfStatementContext): void {
    const behavior = this.currentBehavior();
    if (behavior) behavior.branches += 1;
    this.controlDepth += 1;
  }

  exitIfStatement(): void {
    this.controlDepth -= 1;
  }

  enterSwitchStatement(_ctx: SwitchStatementContext): void {
    const behavior = this.currentBehavior();
    if (behavior) behavior.branches += 1;
    this.controlDepth += 1;
  }

  exitSwitchStatement(): void {
    this.controlDepth -= 1;
  }

  enterForStatement(_ctx: ForStatementContext): void {
    const behavior = this.currentBehavior();
    if (behavior) behavior.loops += 1;
    this.controlDepth += 1;
  }

  exitForStatement(): void {
    this.controlDepth -= 1;
  }

  enterWhileStatement(_ctx: WhileStatementContext): void {
    const behavior = this.currentBehavior();
    if (behavior) behavior.loops += 1;
    this.controlDepth += 1;
  }

  exitWhileStatement(): void {
    this.controlDepth -= 1;
  }

  enterDoWhileStatement(_ctx: DoWhileStatementContext): void {
    const behavior = this.currentBehavior();
    if (behavior) behavior.loops += 1;
    this.controlDepth += 1;
  }

  exitDoWhileStatement(): void {
    this.controlDepth -= 1;
  }

  enterTryStatement(_ctx: TryStatementContext): void {
    const behavior = this.currentBehavior();
    if (behavior) behavior.tryBlocks += 1;
    this.controlDepth += 1;
  }

  exitTryStatement(): void {
    this.controlDepth -= 1;
  }

  enterThrowStatement(_ctx: ThrowStatementContext): void {
    const behavior = this.currentBehavior();
    if (behavior) behavior.throws += 1;
  }

  enterExpressionStatement(ctx: ExpressionStatementContext): void {
    const behavior = this.currentBehavior();
    if (!behavior) return;
    const expressionText = ctx.expression().getText();
    const assignment = /^(.+?)(?:\+=|-=|\*=|\/=|=(?!=))/.exec(expressionText);
    if (assignment?.[1]) {
      behavior.assignments += 1;
      behavior.assignmentTargets.push(assignment[1]);
      this.invalidateAssignedString(assignment[1]);
    }
    const simpleAssignment = /^([A-Za-z_]\w*)=(?!=)([\s\S]+)$/.exec(expressionText);
    if (simpleAssignment?.[1] && simpleAssignment[2]) {
      const name = normalizeName(simpleAssignment[1]);
      const type = this.resolveVariableType(name);
      if (type) {
        behavior.valueBindings.push({
          name,
          type,
          expression: simpleAssignment[2],
          conditional: this.controlDepth > 0,
          location: this.location(ctx),
        });
        const metadataType = repositoryMetadataExpressionType(type, simpleAssignment[2]);
        if (metadataType) this.currentExecutable()?.repositoryMetadataVariables.set(name, metadataType);
        else this.currentExecutable()?.repositoryMetadataVariables.delete(name);
      }
    }
  }

  enterReturnStatement(ctx: ReturnStatementContext): void {
    const expression = ctx.expression()?.getText();
    if (expression) this.currentBehavior()?.returnExpressions.push({ expression, location: this.location(ctx) });
  }

  enterQuery(ctx: QueryContext): void {
    const behavior = this.currentBehavior();
    const symbolId = this.currentSourceId();
    if (!behavior || !symbolId) return;
    const object = ctx.fromNameList().getText().split(",", 1)[0] ?? "unknown";
    const fields = ctx.selectList().selectEntry_list().map((entry) => entry.getText()).sort((left, right) => left.localeCompare(right));
    const filterShape = normalizeSoqlFragment(ctx.whereClause()?.getText() ?? "");
    const observation: SoqlObservation = {
      symbolId,
      object,
      fields,
      filterShape,
      normalizedQuery: normalizeSoqlFragment(ctx.getText()),
      dynamic: false,
      ...soqlSemantics(ctx.getText(), this.currentType()?.symbol),
      location: this.location(ctx),
    };
    behavior.queries.push(observation);
  }

  enterInsertStatement(ctx: InsertStatementContext): void {
    this.recordDml("insert", ctx.expression().getText(), ctx);
  }

  enterUpdateStatement(ctx: UpdateStatementContext): void {
    this.recordDml("update", ctx.expression().getText(), ctx);
  }

  enterDeleteStatement(ctx: DeleteStatementContext): void {
    this.recordDml("delete", ctx.expression().getText(), ctx);
  }

  enterUndeleteStatement(ctx: UndeleteStatementContext): void {
    this.recordDml("undelete", ctx.expression().getText(), ctx);
  }

  enterUpsertStatement(ctx: UpsertStatementContext): void {
    this.recordDml("upsert", ctx.expression().getText(), ctx);
  }

  enterMergeStatement(ctx: MergeStatementContext): void {
    this.recordDml("merge", ctx.expression_list().map((expression) => expression.getText()).join(","), ctx);
  }

  enterMethodCall(ctx: MethodCallContext): void {
    const name = ctx.id()?.getText() ?? ctx.getText().split("(", 1)[0] ?? "";
    const argumentsList = ctx.expressionList()?.expression_list() ?? [];
    this.currentBehavior()?.callDetails.push(ctx.getText());
    this.references.push({
      sourceId: this.currentSourceId(),
      kind: "call",
      memberName: name,
      arity: expressionCount(ctx.expressionList()),
      arguments: argumentsList.map((item) => item.getText()),
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
    const argumentsList = ctx.expressionList()?.expression_list() ?? [];
    const constructedReceiver = /^new([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\(/i.exec(receiver)?.[1];
    const receiverType = normalizeName(receiver) === "this"
      ? (this.currentType()?.symbol.qualifiedName ?? receiver)
      : normalizeName(receiver) === "super"
        ? (this.currentType()?.symbol.superclass ?? receiver)
        : (constructedReceiver ?? this.resolveVariableType(receiver) ?? receiver);
    this.currentBehavior()?.callDetails.push(parent.getText());
    this.references.push({
      sourceId: this.currentSourceId(),
      kind: "call",
      memberName: name,
      arity: expressionCount(ctx.expressionList()),
      arguments: argumentsList.map((item) => item.getText()),
      receiver,
      receiverType,
      testContext: this.inTestContext(),
      location: this.location(ctx),
      detail: parent.getText(),
    });

    if (normalizeName(simpleTypeName(receiverType)) === "database") {
      const normalizedMethod = normalizeName(name);
      const firstArgument = argumentsList[0]?.getText() ?? "";
      if (normalizedMethod === "query" || normalizedMethod === "querywithbinds") {
        this.recordDynamicQuery(firstArgument, ctx);
      }
      const databaseDml = new Map<string, DmlObservation["operation"]>([
        ["insert", "insert"], ["update", "update"], ["delete", "delete"],
        ["undelete", "undelete"], ["upsert", "upsert"], ["merge", "merge"],
      ]).get(normalizedMethod);
      if (databaseDml && firstArgument) {
        const dmlArguments = argumentsList.map((item) => item.getText());
        const { allOrNone, accessMode } = databaseDmlOptions(databaseDml, dmlArguments);
        this.recordDml(databaseDml, firstArgument, ctx, allOrNone, accessMode);
      }
    }

    if (normalizeName(simpleTypeName(receiverType)) === "type" && normalizeName(name) === "forname") {
      const argument = ctx.expressionList()?.getText() ?? "";
      const foldedTypeName = foldApexString(argument, (identifier) => this.resolveStringValue(identifier));
      const literal = foldedTypeName && /^[A-Za-z_][\w.]*$/.test(foldedTypeName) ? foldedTypeName : undefined;
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
        const repositoryMetadataField = this.resolveRepositoryMetadataField(argument);
        this.blockers.push({
          code: "dynamic-type",
          scope: "reference",
          message: `Type.forName(${argument}) depends on a runtime value and can reference a class that has no lexical caller.`,
          blocksClosedWorldConclusion: true,
          ...(sourceId ? { symbolId: sourceId } : {}),
          ...(repositoryMetadataField ? { repositoryMetadataField } : {}),
          dynamicExpression: argument,
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
    const location = this.location(ctx);
    const symbol: ApexSymbol = {
      id: symbolIdentity("type", qualifiedName, this.filePath, location),
      kind,
      name,
      qualifiedName,
      ...(parent ? { ownerId: parent.id } : {}),
      modifiers: normalizeModifiers(modifiers),
      annotations,
      interfaces,
      ...(superclass ? { superclass } : {}),
      testCode: kind !== "trigger" && (parent?.testCode === true || annotations.includes("istest")),
      location,
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
    parameterNames: string[] = [],
  ): ApexSymbol {
    const annotations = annotationsOf(modifiers);
    const signature = parameterTypes.map(normalizeName).join(",");
    const qualifiedName = `${owner.qualifiedName}.${name}(${parameterTypes.join(", ")})`;
    const location = this.location(ctx);
    return {
      id: symbolIdentity(kind, `${owner.qualifiedName}.${name}(${signature})`, this.filePath, location),
      kind,
      name,
      qualifiedName,
      ownerId: owner.id,
      arity: parameterTypes.length,
      parameterTypes,
      parameterNames,
      modifiers: normalizeModifiers(modifiers),
      annotations,
      interfaces: [],
      testCode: owner.testCode || annotations.includes("istest") || normalizeModifiers(modifiers).includes("testmethod"),
      location,
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

  private recordDml(
    operation: DmlObservation["operation"],
    targetExpression: string,
    ctx: ContextLike,
    allOrNone: DmlObservation["allOrNone"] = "default",
    accessMode: DmlObservation["accessMode"] = /\basuser\b/i.test(ctx.getText()) ? "user" : /\bassystem\b/i.test(ctx.getText()) ? "system" : "default",
  ): void {
    const behavior = this.currentBehavior();
    const symbolId = this.currentSourceId();
    if (!behavior || !symbolId) return;
    const targetType = this.inferDmlTargetType(targetExpression);
    behavior.dml.push({
      symbolId,
      operation,
      targetExpression,
      ...(targetType ? { targetType } : {}),
      allOrNone,
      accessMode,
      location: this.location(ctx),
    });
  }

  private recordDynamicQuery(expression: string, ctx: ContextLike): void {
    const behavior = this.currentBehavior();
    const symbolId = this.currentSourceId();
    if (!behavior || !symbolId) return;
    const folded = foldApexString(expression, (identifier) => this.resolveStringValue(identifier));
    const parsed = folded ? parseDynamicSoql(folded) : undefined;
    if (!parsed) {
      behavior.dynamicQueryGaps.push({
        symbolId,
        expression,
        reason: folded ? "The constant string is not a supported SELECT query." : "The query string contains a value that cannot be constant-folded from repository source.",
        location: this.location(ctx),
      });
      return;
    }
    behavior.queries.push({
      ...parsed,
      ...soqlSemantics(folded!, this.currentType()?.symbol),
      symbolId,
      dynamic: true,
      location: this.location(ctx),
    });
  }

  private recordAdvancedCollection(typeName: string): void {
    if (/^(?:Map|Set)</i.test(typeName)) this.currentBehavior()?.advancedCollectionTypes.push(typeName);
  }

  private inferDmlTargetType(expression: string): string | undefined {
    const constructed = /^new([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(expression)?.[1];
    const base = /^[A-Za-z_]\w*/.exec(expression)?.[0];
    const declared = constructed ?? (base ? this.resolveVariableType(base) : undefined);
    if (!declared) return undefined;
    const collectionMember = /^(?:List|Set)<(.+)>$/i.exec(declared)?.[1];
    return simpleTypeName(collectionMember ?? declared);
  }

  private currentBehavior(): ExecutableBehavior | undefined {
    return this.behaviorStack.at(-1);
  }

  private finishBehavior(): void {
    const behavior = this.behaviorStack.pop();
    if (!behavior) return;
    behavior.callDetails = [...new Set(behavior.callDetails)];
    this.behaviors.push(behavior);
  }

  private resolveVariableType(receiver: string): string | undefined {
    const normalized = normalizeName(receiver.replace(/^(this|super)\./i, ""));
    const simple = normalized.split(".").at(-1) ?? normalized;
    return this.currentExecutable()?.variables.get(simple) ?? this.currentType()?.variables.get(simple);
  }

  private resolveStringValue(identifier: string): string | undefined {
    const normalized = normalizeName(identifier.replace(/^(?:this|super)\./i, ""));
    const simple = normalized.split(".").at(-1) ?? normalized;
    return this.currentExecutable()?.strings.get(normalized)
      ?? this.currentExecutable()?.strings.get(simple)
      ?? this.currentType()?.strings.get(normalized)
      ?? this.currentType()?.strings.get(simple);
  }

  private invalidateAssignedString(target: string): void {
    const normalized = normalizeName(target.replace(/^(?:this|super)\./i, ""));
    const simple = normalized.split(".").at(-1) ?? normalized;
    this.currentExecutable()?.strings.delete(normalized);
    this.currentExecutable()?.strings.delete(simple);
    this.currentType()?.strings.delete(normalized);
    this.currentType()?.strings.delete(simple);
  }

  private resolveRepositoryMetadataField(expression: string): string | undefined {
    const compact = expression.replace(/\s+/g, "");
    const baseVariable = /^([A-Za-z_]\w*)/.exec(compact)?.[1];
    const field = /\.([A-Za-z_]\w*__c)$/.exec(compact)?.[1];
    if (!baseVariable || !field) return undefined;
    const metadataType = this.currentExecutable()?.repositoryMetadataVariables.get(normalizeName(baseVariable));
    if (!metadataType) return undefined;
    return normalizeName(`${metadataType}.${field}`);
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

function parameterNamesOf(ctx: { formalParameterList(): { formalParameter_list(): FormalParameterContext[] } | null }): string[] {
  return ctx.formalParameterList()?.formalParameter_list().map((parameter) => parameter.id().getText()) ?? [];
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

function newBehavior(symbolId: string): ExecutableBehavior {
  return {
    symbolId,
    statements: 0,
    branches: 0,
    loops: 0,
    tryBlocks: 0,
    throws: 0,
    assignments: 0,
    assignmentTargets: [],
    valueBindings: [],
    returnExpressions: [],
    enhancedForLoops: [],
    advancedCollectionTypes: [],
    callDetails: [],
    queries: [],
    dynamicQueryGaps: [],
    dml: [],
  };
}

function symbolIdentity(kind: string, logicalName: string, filePath: string, location: SourceLocation): string {
  return `${kind}:${normalizeName(logicalName)}@${normalizeName(filePath)}:${location.line}:${location.column}`;
}

function foldApexString(expression: string, resolveIdentifier: (identifier: string) => string | undefined = () => undefined): string | undefined {
  const unwrapped = unwrapParentheses(expression.trim());
  const pieces = splitStringConcatenation(unwrapped);
  if (pieces.length === 0) return undefined;
  const values: string[] = [];
  for (const rawPiece of pieces) {
    const piece = unwrapParentheses(rawPiece.trim());
    const literal = /^'(?:\\.|[^'])*'$/.test(piece)
      ? piece.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\")
      : undefined;
    if (literal !== undefined) {
      values.push(literal);
      continue;
    }
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(piece)) {
      const resolved = resolveIdentifier(piece);
      if (resolved === undefined) return undefined;
      values.push(resolved);
      continue;
    }
    return undefined;
  }
  return values.join("");
}

function splitStringConcatenation(expression: string): string[] {
  const pieces: string[] = [];
  let quoted = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'" && expression[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "+" && depth === 0) {
      pieces.push(expression.slice(start, index));
      start = index + 1;
    }
  }
  pieces.push(expression.slice(start));
  return pieces;
}

function unwrapParentheses(expression: string): string {
  let result = expression;
  while (result.startsWith("(") && result.endsWith(")") && enclosesWholeExpression(result)) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

function enclosesWholeExpression(expression: string): boolean {
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'" && expression[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0 && index < expression.length - 1) return false;
    }
  }
  return depth === 0;
}

function isFinalField(ctx: FieldDeclarationContext): boolean {
  const declaration = ctx.parentCtx?.parentCtx as ContextLike & { modifier_list?: () => Array<{ getText(): string }> };
  return declaration.modifier_list?.().some((modifier) => normalizeName(modifier.getText()) === "final") ?? false;
}

function repositoryMetadataExpressionType(declaredType: string, initializer: string): string | undefined {
  const collectionMember = /^(?:List|Set)<(.+)>$/i.exec(declaredType)?.[1]
    ?? /^Map<[^,]+,(.+)>$/i.exec(declaredType)?.[1];
  const metadataType = simpleTypeName(collectionMember ?? declaredType);
  if (!/__mdt$/i.test(metadataType)) return undefined;
  const normalizedInitializer = normalizeName(initializer);
  if (normalizedInitializer.startsWith("[select") && normalizedInitializer.includes(`from${normalizeName(metadataType)}`)) return metadataType;
  if (normalizedInitializer.includes(`${normalizeName(metadataType)}.getall()`)
    || normalizedInitializer.includes(`${normalizeName(metadataType)}.getinstance(`)) return metadataType;
  return undefined;
}

function parseDynamicSoql(query: string): Omit<SoqlObservation, "symbolId" | "dynamic" | "location" | "securityMode" | "sharingContext" | "aggregate" | "locking"> | undefined {
  const match = /^\s*select\s+([\s\S]+?)\s+from\s+([A-Za-z_]\w*)([\s\S]*)$/i.exec(query);
  if (!match) return undefined;
  const tail = match[3] ?? "";
  const where = /\bwhere\b([\s\S]*?)(?=\b(?:group\s+by|having|order\s+by|limit|offset|for\s+(?:update|view|reference)|with\s+)\b|$)/i.exec(tail)?.[1] ?? "";
  return {
    object: match[2]!,
    fields: splitTopLevel(match[1]!, ",").map((field) => field.trim()).filter(Boolean).sort((left, right) => left.localeCompare(right)),
    filterShape: normalizeSoqlFragment(where),
    normalizedQuery: normalizeSoqlFragment(query),
  };
}

function splitTopLevel(value: string, separator: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === separator && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

function normalizeSoqlFragment(value: string): string {
  return value
    .replace(/'(?:\\.|[^'])*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g, ":bind")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function soqlSemantics(query: string, owner: ApexSymbol | undefined): Pick<SoqlObservation, "securityMode" | "sharingContext" | "aggregate" | "locking"> {
  const normalized = query.replace(/\s+/g, "").toLowerCase();
  const modifiers = owner?.modifiers.join("").toLowerCase() ?? "";
  return {
    securityMode: normalized.includes("withuser_mode") || normalized.includes("withusermode") ? "user"
      : normalized.includes("withsystem_mode") || normalized.includes("withsystemmode") ? "system"
        : normalized.includes("withsecurity_enforced") ? "security-enforced" : "unspecified",
    sharingContext: modifiers.includes("withsharing") ? "with-sharing"
      : modifiers.includes("withoutsharing") ? "without-sharing"
        : modifiers.includes("inheritedsharing") ? "inherited-sharing" : "unspecified",
    aggregate: /(?:count|sum|avg|min|max)\(/i.test(normalized) || normalized.includes("groupby"),
    locking: normalized.includes("forupdate"),
  };
}

function booleanOption(value: string | undefined): DmlObservation["allOrNone"] {
  if (value === undefined) return "default";
  if (/^true$/i.test(value)) return "true";
  if (/^false$/i.test(value)) return "false";
  if (/^(?:AccessLevel\.|System\.)/i.test(value)) return "default";
  return "dynamic";
}

function accessLevelOption(values: string[]): DmlObservation["accessMode"] {
  if (values.some((value) => /(?:AccessLevel\.)?USER_MODE/i.test(value))) return "user";
  if (values.some((value) => /(?:AccessLevel\.)?SYSTEM_MODE/i.test(value))) return "system";
  return "default";
}

function databaseDmlOptions(
  operation: DmlObservation["operation"],
  values: string[],
): Pick<DmlObservation, "allOrNone" | "accessMode"> {
  const accessMode = accessLevelOption(values);
  const booleanIndex = values.findIndex((value, index) => index > 0 && /^(?:true|false)$/i.test(value));
  if (booleanIndex >= 0) return { allOrNone: booleanOption(values[booleanIndex]), accessMode };
  const nonAccessOptions = values.slice(1).filter((value) => !/(?:AccessLevel\.)?(?:USER|SYSTEM)_MODE/i.test(value));
  if (nonAccessOptions.length === 0) return { allOrNone: "default", accessMode };
  // Upsert's external-id field and merge's duplicate-record argument are not
  // allOrNone parameters; only a following option can be a computed Boolean.
  if (operation === "upsert" && nonAccessOptions.length === 1 && /(?:Schema\.)?[A-Za-z_]\w*\.[A-Za-z_]\w*/.test(nonAccessOptions[0]!)) {
    return { allOrNone: "default", accessMode };
  }
  if (operation === "merge" && nonAccessOptions.length === 1) return { allOrNone: "default", accessMode };
  return { allOrNone: "dynamic", accessMode };
}
