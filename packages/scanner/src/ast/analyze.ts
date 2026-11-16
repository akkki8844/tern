/**
 * Single-pass per-file AST analysis.
 *
 * Walks one tree-sitter tree and produces every fact the rest of the scanner
 * needs, in canonical form:
 *
 * - scope tree (module / function / block / class) with declaration tables —
 *   this is what makes shadowing correct: references bind to the innermost
 *   declaration, never to a same-named import somewhere else in the file;
 * - import and export statements (resolution to modules happens later, in the
 *   module graph, against the discovered file set and tsconfig paths);
 * - call expressions with resolved callee chains and argument shapes;
 * - object literals with flattened property paths (request-body analysis);
 * - property-access chains rooted at identifiers (response-usage analysis);
 * - variable initialisation shapes, so `const api = axios.create(...)`,
 *   `const USERS_PATH = "/users"` and aliases are understood structurally;
 * - type annotations and interface/type members, where statically available.
 *
 * Nothing here executes code, reads files, or depends on file order.
 */
import type Parser from "tree-sitter";
import {
  type AccessRecord,
  type ArgumentShape,
  type CallRecord,
  type ChainSegment,
  type ExportRecord,
  type ImportRecord,
  type ObjectLiteralRecord,
  type ObjectProperty,
  type ParseOutcome,
  type Range,
  type Scope,
  type ScopeKind,
  type StringPart,
  type SymbolDeclaration,
  type SymbolKind,
  type TemplatePart,
  type TypeMember,
  type VariableInit
} from "../model/types.js";

export interface FileAnalysis {
  readonly file: string;
  readonly imports: ImportRecord[];
  readonly exports: ExportRecord[];
  readonly scopes: Scope[];
  readonly declarations: SymbolDeclaration[];
  readonly calls: CallRecord[];
  readonly objects: ReadonlyMap<string, ObjectLiteralRecord>;
  readonly accesses: AccessRecord[];
  readonly destructuringAliases: ReadonlyArray<DestructuringAlias>;
  readonly parse: ParseOutcome;
}

const FUNCTION_LIKE = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition"
]);

const BLOCK_SCOPE_PARENTS = new Set([
  "statement_block",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_body",
  "try_statement",
  "catch_clause",
  "finally_clause"
]);

const MAX_TEXT = 160;

export class FileAnalyzer {
  private scopes: Scope[] = [];
  private declarations: SymbolDeclaration[] = [];
  private calls: CallRecord[] = [];
  private accesses: AccessRecord[] = [];
  private objects = new Map<string, ObjectLiteralRecord>();
  private imports: ImportRecord[] = [];
  private exports: ExportRecord[] = [];
  private ordinalsByScope = new Map<string, number>();
  private readonly maxDepth: number;

  constructor(
    private readonly file: string,
    private readonly rootNode: Parser.SyntaxNode,
    options: { maxObjectDepth: number }
  ) {
    this.maxDepth = options.maxObjectDepth;
  }

  analyze(): FileAnalysis {
    const moduleScope = this.makeScope("module", undefined, [], this.range(this.rootNode));
    this.walk(this.rootNode, moduleScope.id, { insideAwait: false, function: undefined });
    this.scopes.sort(byScopePath);
    return {
      file: this.file,
      imports: this.imports,
      exports: this.exports,
      scopes: this.scopes,
      declarations: this.declarations,
      calls: this.calls,
      objects: this.objects,
      accesses: this.accesses,
      destructuringAliases: this.destructuringAliases,
      parse: { ok: true, nodeCount: 0 }
    };
  }

  // -- scopes ---------------------------------------------------------------

  private makeScope(kind: ScopeKind, parent: string | undefined, path: number[], range: Range): Scope {
    const parentScope = parent ? this.scopes.find((s) => s.id === parent) : undefined;
    const fullPath = parentScope ? [...parentScope.path, ...path] : path;
    const id = `${this.file}#s${fullPath.join(".")}`;
    const scope: Scope = { id, kind, parent, path: fullPath, range };
    this.scopes.push(scope);
    return scope;
  }

  private childScope(parentId: string, kind: ScopeKind, ordinal: number, range: Range): Scope {
    const parent = this.scopes.find((s) => s.id === parentId);
    const index = parent ? parent.path.length : 0;
    return this.makeScope(kind, parentId, [ordinal], range);
    // fullPath computed in makeScope; ordinal uniqueness within the parent is
    // guaranteed by a per-parent counter maintained by callers.
    void index;
  }

  // -- declarations ---------------------------------------------------------

  private declare(
    name: string,
    kind: SymbolKind,
    scopeId: string,
    range: Range,
    extra?: Partial<SymbolDeclaration>
  ): SymbolDeclaration {
    const ordinals = new Map<string, number>();
    for (const d of this.declarations) {
      if (d.scopeId === scopeId) ordinals.set(d.name, (ordinals.get(d.name) ?? 0) + 1);
    }
    const ordinal = ordinals.get(name) ?? 0;
    const scope = this.scopes.find((s) => s.id === scopeId);
    const id = `${this.file}#${(scope?.path ?? []).join(".")}#${name}#${ordinal}`;
    const decl: SymbolDeclaration = { id, name, kind, scopeId, range, exported: false, ...extra };
    this.declarations.push(decl);
    return decl;
  }

  // -- traversal ------------------------------------------------------------

  private walk(node: Parser.SyntaxNode, scopeId: string, ctx: WalkContext): void {
    switch (node.type) {
      case "import_statement":
        this.collectImport(node, scopeId);
        return;
      case "export_statement":
        this.collectExport(node, scopeId, ctx);
        return;
      case "function_declaration":
      case "generator_function_declaration": {
        const name = fieldName(node, "name")?.text;
        if (name) {
          const decl = this.declare(name, "function", scopeId, this.range(node));
          this.enterFunction(node, decl.id, name, scopeId);
        }
        return;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = fieldName(node, "name")?.text;
        if (name) {
          const decl = this.declare(name, "class", scopeId, this.range(node));
          const body = fieldName(node, "body");
          if (body) {
            const classScope = this.childScope(scopeId, "class", this.ordinalFor(scopeId), this.range(body));
            this.walkClassBody(body, classScope.id, name, decl.id, ctx);
          }
        }
        return;
      }
      case "lexical_declaration":
      case "variable_declaration":
        this.collectVariableDeclaration(node, scopeId, ctx);
        return;
      case "interface_declaration": {
        const name = fieldName(node, "name")?.text;
        if (name) {
          this.declare(name, "interface", scopeId, this.range(node), {
            typeMembers: collectTypeMembers(node)
          });
        }
        return;
      }
      case "type_alias_declaration": {
        const name = fieldName(node, "name")?.text;
        if (name) {
          this.declare(name, "type-alias", scopeId, this.range(node), {
            typeMembers: collectTypeMembers(node)
          });
        }
        return;
      }
      case "enum_declaration": {
        const name = fieldName(node, "name")?.text;
        if (name) this.declare(name, "enum", scopeId, this.range(node));
        return;
      }
      case "internal_module":
      case "module": {
        const name = fieldName(node, "name")?.text;
        if (name) {
          const decl = this.declare(name, "namespace", scopeId, this.range(node));
          const body = fieldName(node, "body");
          if (body) {
            const nsScope = this.childScope(scopeId, "block", this.ordinalFor(scopeId), this.range(body));
            // Names declared inside a namespace are module-visible when exported;
            // we model the namespace body as a child scope and record the link.
            for (const child of body.namedChildren) {
              this.walk(child, nsScope.id, ctx);
            }
          }
          void decl;
        }
        return;
      }
      case "expression_statement":
      case "assignment_expression":
      case "variable_declarator":
      case "pair":
      case "return_statement":
      case "await_expression":
      case "parenthesized_expression":
      case "binary_expression":
      case "member_expression":
      case "subscript_expression":
      case "arguments":
      case "template_string":
      case "jsx_expression_container":
      case "arrow_function":
        // Falls through to generic recursion for expressions; calls and
        // accesses are collected below.
        this.walkGeneric(node, scopeId, ctx);
        return;
      default:
        this.walkGeneric(node, scopeId, ctx);
    }
  }

  /** Generic recursion used by statement/compound nodes. */
  private walkGeneric(node: Parser.SyntaxNode, scopeId: string, ctx: WalkContext): void {
    if (FUNCTION_LIKE.has(node.type)) {
      this.enterFunctionLike(node, scopeId);
      return;
    }
    if (node.type === "call_expression") {
      this.collectCall(node, scopeId, ctx);
      // Still descend into arguments for nested calls/objects.
      const args = fieldName(node, "arguments");
      if (args) {
        for (const child of args.namedChildren) this.walk(child, scopeId, ctx);
      }
      const fn = fieldName(node, "function");
      if (fn && fn.namedChildren.length > 0) {
        // descend into callee object expressions (e.g. IIFE args, computed roots)
        for (const child of fn.namedChildren) {
          if (child.type === "call_expression" || child.type === "parenthesized_expression") {
            this.walk(child, scopeId, ctx);
          }
        }
      }
      return;
    }
    if (node.type === "new_expression") {
      this.collectNew(node, scopeId, ctx);
      const args = fieldName(node, "arguments");
      if (args) for (const child of args.namedChildren) this.walk(child, scopeId, ctx);
      return;
    }
    if (node.type === "object") {
      this.collectObject(node);
      for (const child of node.namedChildren) this.walk(child, scopeId, ctx);
      return;
    }
    if (node.type === "member_expression" || node.type === "subscript_expression") {
      this.collectAccess(node, scopeId, ctx);
      for (const child of node.namedChildren) this.walk(child, scopeId, ctx);
      return;
    }
    if (BLOCK_SCOPE_PARENTS.has(node.type)) {
      const body = fieldName(node, "body");
      if (body && body.type === "statement_block") {
        const blockScope = this.childScope(scopeId, "block", this.ordinalFor(scopeId), this.range(body));
        for (const child of body.namedChildren) this.walk(child, blockScope.id, ctx);
        // Siblings that are not the body (e.g. `for` init/condition) keep parent scope.
        for (const child of node.namedChildren) {
          if (child !== body) this.walk(child, scopeId, ctx);
        }
        return;
      }
    }
    if (node.type === "statement_block") {
      const blockScope = this.childScope(scopeId, "block", this.ordinalFor(scopeId), this.range(node));
      for (const child of node.namedChildren) this.walk(child, blockScope.id, ctx);
      return;
    }
    for (const child of node.namedChildren) this.walk(child, scopeId, ctx);
  }

  private ordinalFor(scopeId: string): number {
    const next = this.ordinalsByScope.get(scopeId) ?? 0;
    this.ordinalsByScope.set(scopeId, next + 1);
    return next;
  }

  // -- functions ------------------------------------------------------------

  private enterFunction(
    node: Parser.SyntaxNode,
    declId: string,
    name: string,
    scopeId: string
  ): void {
    const params = this.parametersOf(node);
    const body = fieldName(node, "body");
    const fnScope = this.childScope(scopeId, "function", this.ordinalFor(scopeId), this.range(node));
    if (params) this.collectParameters(params, fnScope.id);
    const returnType = findReturnTypeAnnotation(node);
    if (returnType) this.patchDeclaration(declId, { typeAnnotation: returnType });
    const inner: WalkContext = { insideAwait: false, function: { id: declId, name } };
    if (body) {
      const bodyScope =
        body.type === "statement_block"
          ? this.childScope(fnScope.id, "block", this.ordinalFor(fnScope.id), this.range(body))
          : fnScope.id === undefined
            ? fnScope.id
            : this.childScope(fnScope.id, "block", this.ordinalFor(fnScope.id), this.range(body));
      for (const child of body.namedChildren) this.walk(child, bodyScope.id, inner);
    } else {
      // Signature-only (declaration files, overloads).
      void scopeId;
    }
  }

  private enterFunctionLike(node: Parser.SyntaxNode, scopeId: string): void {
    // Arrows/function expressions: use the variable name when assigned.
    let name: string | undefined;
    const parent = node.parent;
    if (parent && (parent.type === "variable_declarator" || parent.type === "pair" || parent.type === "assignment_expression")) {
      const nameNode =
        parent.type === "pair" ? fieldName(parent, "key") : fieldName(parent, "name") ?? fieldName(parent, "left");
      name = nameNode?.text;
    }
    if (parent?.type === "method_definition") {
      const key = fieldName(parent, "name") ?? fieldName(parent, "key");
      name = key?.text;
    }
    if (!name) name = "(anonymous)";
    const declId = this.declare(name, "function", scopeId, this.range(node), {
      init: { kind: "arrow-or-function" }
    }).id;
    const params = this.parametersOf(node);
    const body = fieldName(node, "body");
    const fnScope = this.childScope(scopeId, "function", this.ordinalFor(scopeId), this.range(node));
    if (params) this.collectParameters(params, fnScope.id);
    const inner: WalkContext = { insideAwait: false, function: { id: declId, name } };
    if (body) {
      if (body.type === "statement_block") {
        const bodyScope = this.childScope(fnScope.id, "block", this.ordinalFor(fnScope.id), this.range(body));
        for (const child of body.namedChildren) this.walk(child, bodyScope.id, inner);
      } else {
        // Expression-bodied arrow: analyze in the function scope.
        this.walk(body, fnScope.id, inner);
      }
    }
  }

  private walkClassBody(
    body: Parser.SyntaxNode,
    classScopeId: string,
    className: string,
    classDeclId: string,
    ctx: WalkContext
  ): void {
    for (const member of body.namedChildren) {
      if (member.type === "method_definition") {
        const key = fieldName(member, "name") ?? fieldName(member, "key");
        const methodName = key?.text ?? "(anonymous)";
        const decl = this.declare(methodName, "method", classScopeId, this.range(member));
        const params = fieldName(member, "parameters");
        const fnScope = this.childScope(classScopeId, "function", this.ordinalFor(classScopeId), this.range(member));
        if (params) this.collectParameters(params, fnScope.id);
        const methodBody = fieldName(member, "body");
        const inner: WalkContext = {
          insideAwait: false,
          function: { id: decl.id, name: `${className}.${methodName}` }
        };
        if (methodBody && methodBody.type === "statement_block") {
          const bodyScope = this.childScope(fnScope.id, "block", this.ordinalFor(fnScope.id), this.range(methodBody));
          for (const child of methodBody.namedChildren) this.walk(child, bodyScope.id, inner);
        }
      } else if (member.type === "public_field_definition" || member.type === "field_definition" || member.type === "property_signature") {
        const key = fieldName(member, "name") ?? fieldName(member, "property");
        if (key) {
          this.declare(key.text, "variable", classScopeId, this.range(member), {
            typeAnnotation: findTypeAnnotationText(member)
          });
        }
        const value = fieldName(member, "value");
        if (value) this.walk(value, classScopeId, ctx);
      } else if (member.type === "method_signature" || member.type === "abstract_method_signature") {
        const key = fieldName(member, "name") ?? fieldName(member, "key");
        if (key) this.declare(key.text, "method", classScopeId, this.range(member));
      } else {
        this.walk(member, classScopeId, ctx);
      }
    }
    void classDeclId;
  }

  /**
   * Parameters node of a function-like node. Concise single-parameter arrows
   * (`r => ...`) expose the identifier as the first named child with NO
   * `parameters` field — handled explicitly here.
   */
  private parametersOf(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    const field = fieldName(node, "parameters");
    if (field !== null) return field;
    const first = node.namedChildren[0];
    if (first !== undefined && first.type === "identifier") return first;
    return null;
  }

  private collectParameters(params: Parser.SyntaxNode, scopeId: string): void {
    // Concise arrows declare their single parameter as a bare identifier
    // (`r => ...`) rather than formal_parameters.
    if (params.type === "identifier") {
      this.declare(params.text, "parameter", scopeId, this.range(params), {
        typeAnnotation: undefined
      });
      return;
    }
    for (const child of params.namedChildren) {
      if (child.type === "required_parameter" || child.type === "optional_parameter") {
        const pattern = fieldName(child, "pattern") ?? fieldName(child, "name");
        const typeText = findTypeAnnotationText(child);
        if (pattern) this.declarePattern(pattern, "parameter", scopeId, this.range(child), typeText);
      } else {
        this.declarePattern(child, "parameter", scopeId, this.range(child), undefined);
      }
    }
  }

  /** Declares every binding introduced by a name or destructuring pattern. */
  private declarePattern(
    pattern: Parser.SyntaxNode,
    kind: SymbolKind,
    scopeId: string,
    range: Range,
    typeAnnotation: string | undefined
  ): void {
    switch (pattern.type) {
      case "identifier":
        this.declare(pattern.text, kind, scopeId, range, { typeAnnotation });
        return;
      case "object_pattern":
        for (const child of pattern.namedChildren) {
          if (child.type === "shorthand_property_identifier_pattern") {
            this.declare(child.text, kind, scopeId, range, { typeAnnotation });
          } else if (child.type === "pair") {
            const value = fieldName(child, "value");
            if (value) this.declarePattern(value, kind, scopeId, range, typeAnnotation);
          } else if (child.type === "rest_pattern") {
            const inner = child.namedChildren[0];
            if (inner) this.declare(inner.text, kind, scopeId, range, { typeAnnotation });
          }
        }
        return;
      case "array_pattern":
        for (const child of pattern.namedChildren) this.declarePattern(child, kind, scopeId, range, typeAnnotation);
        return;
      case "rest_pattern": {
        const inner = pattern.namedChildren[0];
        if (inner) this.declare(inner.text, kind, scopeId, range, { typeAnnotation });
        return;
      }
      case "assignment_pattern": {
        const left = fieldName(pattern, "left");
        if (left) this.declarePattern(left, kind, scopeId, range, typeAnnotation);
        return;
      }
      default:
        return;
    }
  }

  // -- variables ------------------------------------------------------------

  private collectVariableDeclaration(node: Parser.SyntaxNode, scopeId: string, ctx: WalkContext): void {
    for (const declarator of node.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const nameNode = fieldName(declarator, "name");
      const valueNode = fieldName(declarator, "value");
      const typeText = findTypeAnnotationText(declarator);
      const init = valueNode ? this.variableInit(valueNode) : { kind: "uninitialized" as const };
      const isFunctionValue =
        valueNode !== null && valueNode !== undefined && FUNCTION_LIKE.has(valueNode.type);
      if (nameNode) {
        const names = patternBindingNames(nameNode);
        for (const name of names) {
          this.declare(name, isFunctionValue ? "function" : "variable", scopeId, this.range(declarator), {
            init: names.length === 1 ? init : { kind: "other", text: "destructured" },
            typeAnnotation: typeText
          });
        }
        // `const { data } = res` / `const { user } = res.data` — record the
        // alias target and property path for response-flow analysis.
        if (nameNode.type === "object_pattern" && valueNode !== null && valueNode !== undefined) {
          const rootText = boundText(valueNode, 80);
          for (const binding of objectPatternBindings(nameNode)) {
            this.destructuringAliases.push({
              name: binding.localName,
              sourceText: rootText,
              path: binding.path,
              rest: binding.rest,
              scopeId
            });
          }
        } else if (nameNode.type === "identifier" && valueNode && valueNode.type === "identifier") {
          this.destructuringAliases.push({
            name: nameNode.text,
            sourceText: valueNode.text,
            path: [],
            rest: false,
            scopeId
          });
        }
      }
      if (valueNode) {
        const outerNames = ctx.declaratorNames;
        const outerAssigning = ctx.assigningTo;
        if (nameNode && nameNode.type === "identifier") ctx.declaratorNames = [nameNode.text];
        else if (nameNode && nameNode.type === "object_pattern") ctx.declaratorNames = objectPatternBindings(nameNode).map((b) => b.localName);
        else ctx.declaratorNames = undefined;
        // `const res = await api.get(…)` — the call record learns its binding.
        ctx.assigningTo = nameNode && nameNode.type === "identifier" ? nameNode.text : undefined;
        this.walk(valueNode, scopeId, ctx);
        ctx.declaratorNames = outerNames;
        ctx.assigningTo = outerAssigning;
      }
    }
  }

  /** Destructuring/alias bindings used by response-flow analysis. */
  readonly destructuringAliases: DestructuringAlias[] = [];

  private variableInit(valueNode: Parser.SyntaxNode): VariableInit {
    switch (valueNode.type) {
      case "string":
        return { kind: "literal", value: stringValue(valueNode) };
      case "template_string":
        return { kind: "template", parts: templateParts(valueNode) };
      case "binary_expression": {
        const parts = flattenConcat(valueNode);
        if (parts !== null) return { kind: "binary-concat", parts };
        return { kind: "other", text: boundText(valueNode) };
      }
      case "identifier":
        return { kind: "identifier", target: valueNode.text };
      case "new_expression":
      case "call_expression": {
        const fn = fieldName(valueNode, "function") ?? fieldName(valueNode, "constructor");
        const args = fieldName(valueNode, "arguments");
        const argTexts: string[] = [];
        const argObjectIds: string[] = [];
        for (const a of args?.namedChildren ?? []) {
          argTexts.push(boundText(a, 60));
          if (a.type === "object") {
            argObjectIds.push(this.collectObject(a).id);
          } else {
            argObjectIds.push("");
          }
        }
        return {
          kind: "call",
          calleeText: fn?.text ?? valueNode.text,
          argTexts,
          ...(argObjectIds.some((id) => id !== "") ? { argObjectIds } : {})
        };
      }
      case "await_expression": {
        const inner = valueNode.namedChildren[0];
        return inner ? this.variableInit(inner) : { kind: "other", text: boundText(valueNode) };
      }
      case "object":
        return { kind: "object-literal" };
      case "arrow_function":
      case "function_expression":
      case "generator_function":
        return { kind: "arrow-or-function" };
      case "new_expression_target":
        return { kind: "class-expression" };
      case "as_expression": {
        const inner = valueNode.namedChildren[0];
        return inner ? this.variableInit(inner) : { kind: "other", text: boundText(valueNode) };
      }
      default:
        return { kind: "other", text: boundText(valueNode) };
    }
  }

  private patchDeclaration(id: string, patch: Partial<SymbolDeclaration>): void {
    const index = this.declarations.findIndex((d) => d.id === id);
    if (index >= 0) this.declarations[index] = { ...this.declarations[index], ...patch };
  }

  // -- imports / exports ----------------------------------------------------

  private collectImport(node: Parser.SyntaxNode, scopeId: string): void {
    const sourceNode = fieldName(node, "source");
    if (!sourceNode) return;
    const specifier = stringValue(sourceNode);
    const typeOnly = node.text.startsWith("import type");
    const named: Array<{ imported: string; local: string }> = [];
    let defaultLocal: string | undefined;
    let namespaceLocal: string | undefined;
    let sideEffectOnly = false;
    const clause = node.namedChildren.find((c) => c.type === "import_clause");
    if (!clause) {
      sideEffectOnly = true;
    } else {
      for (const child of clause.namedChildren) {
        if (child.type === "identifier") {
          defaultLocal = child.text;
          this.declare(child.text, "import", scopeId, this.range(node), {
            importOf: { moduleId: undefined, specifier, importedName: "default", importKind: "default" }
          });
        } else if (child.type === "namespace_import") {
          const id = child.namedChildren.find((c) => c.type === "identifier");
          if (id) {
            namespaceLocal = id.text;
            this.declare(id.text, "import", scopeId, this.range(node), {
              importOf: { moduleId: undefined, specifier, importedName: "*", importKind: "namespace" }
            });
          }
        } else if (child.type === "named_imports") {
          for (const spec of child.namedChildren) {
            if (spec.type !== "import_specifier") continue;
            const nameNode = fieldName(spec, "name");
            const aliasNode = fieldName(spec, "alias");
            const imported = nameNode?.text;
            const local = aliasNode?.text ?? imported;
            if (imported && local) {
              named.push({ imported, local });
              this.declare(local, "import", scopeId, this.range(node), {
                importOf: { moduleId: undefined, specifier, importedName: imported, importKind: "named" }
              });
            }
          }
        }
      }
    }
    this.imports.push({
      specifier,
      resolved: { kind: "unresolved", reason: "unresolvable-specifier" },
      named,
      sideEffectOnly,
      typeOnly,
      ...(defaultLocal !== undefined ? { defaultLocal } : {}),
      ...(namespaceLocal !== undefined ? { namespaceLocal } : {}),
      range: this.range(node)
    });
  }

  private collectExport(node: Parser.SyntaxNode, scopeId: string, ctx: WalkContext): void {
    const text = node.text;
    const sourceNode = fieldName(node, "source");
    const fromSpecifier = sourceNode ? stringValue(sourceNode) : undefined;
    const isStar = /^\s*export\s+\*/.test(text);

    const clause = node.namedChildren.find((c) => c.type === "export_clause");
    if (clause) {
      for (const spec of clause.namedChildren) {
        if (spec.type !== "export_specifier") continue;
        const nameNode = fieldName(spec, "name");
        const aliasNode = fieldName(spec, "alias");
        const local = nameNode?.text;
        const exported = aliasNode?.text ?? local;
        if (exported) {
          this.exports.push({ name: exported, localName: fromSpecifier ? undefined : local, fromSpecifier, range: this.range(node) });
        }
        void local;
      }
    }

    if (isStar && fromSpecifier) {
      this.exports.push({ name: "*", fromSpecifier, range: this.range(node) });
    }

    // Exported declarations: walk them with the exported flag applied.
    // NOTE: DECLARATION_TYPES includes variable/lexical declarations, so they are
    // handled FIRST here: their tree-sitter node has no `name` field (the name
    // sits on the declarator), and each binding of a destructuring export is a
    // declaration of its own.
    for (const child of node.namedChildren) {
      if (child.type === "export_clause" || child.type === "string") continue;
      if (child.type === "variable_declaration" || child.type === "lexical_declaration") {
        const before = this.declarations.length;
        this.walk(child, scopeId, ctx);
        for (let i = before; i < this.declarations.length; i++) {
          this.patchDeclaration(this.declarations[i].id, { exported: true });
          this.exports.push({ name: this.declarations[i].name, localName: this.declarations[i].name, range: this.range(node) });
        }
      } else if (FUNCTION_LIKE.has(child.type) || DECLARATION_TYPES.has(child.type)) {
        const before = this.declarations.length;
        const beforeExports = this.exports.length;
        this.walk(child, scopeId, ctx);
        // Mark the just-created declarations exported and register export names.
        const nameNode = fieldName(child, "name");
        if (nameNode) {
          const isDefault = /^\s*export\s+default/.test(text);
          this.exports.push({
            name: isDefault ? "default" : nameNode.text,
            localName: nameNode.text,
            range: this.range(node)
          });
          for (let i = before; i < this.declarations.length; i++) {
            if (this.declarations[i].name === nameNode.text) {
              this.patchDeclaration(this.declarations[i].id, { exported: true });
            }
          }
        }
        void beforeExports;
      } else if (child.type === "assignment_expression") {
        // `export const X = ...` is handled above; `module.exports = ...`:
        const left = fieldName(child, "left");
        const right = fieldName(child, "right");
        if (left?.text === "module.exports" && right) {
          this.exports.push({ name: "default", localName: undefined, fromSpecifier: undefined, range: this.range(node) });
          this.walk(right, scopeId, ctx);
        }
      } else {
        this.walk(child, scopeId, ctx);
      }
    }
  }

  // -- calls ----------------------------------------------------------------

  private collectCall(node: Parser.SyntaxNode, scopeId: string, ctx: WalkContext): void {
    const fn = fieldName(node, "function");
    if (!fn) return;
    const chain = flattenCalleeChain(fn);
    // A call is recordable when it has a resolvable root (bare identifier or
    // member chain root); anonymous callees (IIFEs) carry no root.
    if (chain.segments.length === 0 && chain.root === undefined) return;
    const argsNode = fieldName(node, "arguments");
    const args: ArgumentShape[] = (argsNode?.namedChildren ?? []).map((a) => this.argumentShape(a));
    const awaited = ctx.insideAwait || node.parent?.type === "await_expression";
    const call: CallRecord = {
      id: `${this.file}#call#${node.startPosition.row + 1}:${node.startPosition.column + 1}`,
      range: this.range(node),
      callee: chain.segments,
      rootIdentifier: chain.root,
      args,
      awaited,
      insideAwait: ctx.insideAwait,
      enclosingSymbolId: ctx.function?.id,
      enclosingFunctionName: ctx.function?.name,
      scopeId,
      ...(ctx.assigningTo !== undefined ? { assignsTo: ctx.assigningTo } : {})
    };
    this.calls.push(call);
    // Nested calls inside the arguments are NOT the assignment target.
    ctx.assigningTo = undefined;
  }

  private collectNew(node: Parser.SyntaxNode, scopeId: string, ctx: WalkContext): void {
    const ctor = fieldName(node, "constructor");
    if (!ctor) return;
    const chain = flattenCalleeChain(ctor);
    const argsNode = fieldName(node, "arguments");
    const args: ArgumentShape[] = (argsNode?.namedChildren ?? []).map((a) => this.argumentShape(a));
    this.calls.push({
      id: `${this.file}#call#${node.startPosition.row + 1}:${node.startPosition.column + 1}`,
      range: this.range(node),
      callee: chain.segments,
      rootIdentifier: chain.root,
      args,
      awaited: false,
      insideAwait: ctx.insideAwait,
      enclosingSymbolId: ctx.function?.id,
      enclosingFunctionName: ctx.function?.name,
      scopeId
    });
  }

  private argumentShape(node: Parser.SyntaxNode): ArgumentShape {
    switch (node.type) {
      case "string":
        return { kind: "string-literal", value: stringValue(node) };
      case "template_string":
        return { kind: "template", parts: templateParts(node) };
      case "binary_expression": {
        const parts = flattenConcat(node);
        if (parts !== null) return { kind: "binary-concat", parts };
        return { kind: "other", text: boundText(node) };
      }
      case "identifier":
        return { kind: "identifier", name: node.text };
      case "object": {
        const record = this.collectObject(node);
        return { kind: "object", objectId: record.id };
      }
      case "spread_element":
        return { kind: "spread", text: node.namedChildren[0]?.text ?? node.text };
      case "arrow_function":
      case "function_expression":
      case "generator_function":
        return { kind: "arrow-or-function" };
      case "await_expression": {
        const inner = node.namedChildren[0];
        return inner ? this.argumentShape(inner) : { kind: "other", text: boundText(node) };
      }
      case "parenthesized_expression": {
        const inner = node.namedChildren[0];
        return inner ? this.argumentShape(inner) : { kind: "other", text: boundText(node) };
      }
      default:
        return { kind: "other", text: boundText(node) };
    }
  }

  // -- object literals ------------------------------------------------------

  private collectObject(node: Parser.SyntaxNode): ObjectLiteralRecord {
    const id = `${this.file}#obj#${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
    const existing = this.objects.get(id);
    if (existing) return existing;
    const properties: ObjectProperty[] = [];
    let hasSpread = false;
    const collect = (obj: Parser.SyntaxNode, prefix: ReadonlyArray<string>, depth: number): void => {
      if (depth > this.maxDepth) return;
      for (const child of obj.namedChildren) {
        if (child.type === "pair") {
          const key = fieldName(child, "key");
          const value = fieldName(child, "value");
          if (!key) continue;
          const keyText = key.type === "string" ? stringValue(key) : key.type === "computed_property_name" ? undefined : key.text;
          const path = keyText ? [...prefix, keyText] : prefix;
          if (!keyText) {
            properties.push({ path: [...prefix, "<computed>"], valueKind: "computed", range: this.range(child) });
            continue;
          }
          if (!value) continue;
          switch (value.type) {
            case "object": {
              const nested = this.collectObject(value);
              properties.push({ path, valueKind: "object", nestedObjectId: nested.id, range: this.range(child) });
              collect(value, path, depth + 1);
              break;
            }
            case "string":
              properties.push({ path, valueKind: "literal", literalValue: stringValue(value), range: this.range(child) });
              break;
            case "template_string":
              properties.push({ path, valueKind: "template", templateValue: templateParts(value), range: this.range(child) });
              break;
            case "identifier":
              properties.push({ path, valueKind: "identifier", range: this.range(child) });
              break;
            case "call_expression": {
              // `body: JSON.stringify({...})` — capture the inner object.
              const fn = fieldName(value, "function");
              if (fn?.text === "JSON.stringify") {
                const args = fieldName(value, "arguments");
                const first = args?.namedChildren[0];
                if (first?.type === "object") {
                  const nested = this.collectObject(first);
                  properties.push({ path, valueKind: "json-stringify", nestedObjectId: nested.id, range: this.range(child) });
                  break;
                }
              }
              properties.push({ path, valueKind: "other", range: this.range(child) });
              break;
            }
            case "arrow_function":
            case "function_expression":
            case "generator_function":
              properties.push({ path, valueKind: "function", range: this.range(child) });
              break;
            default:
              properties.push({ path, valueKind: "other", range: this.range(child) });
          }
        } else if (child.type === "shorthand_property_identifier") {
          properties.push({ path: [...prefix, child.text], valueKind: "shorthand", range: this.range(child) });
        } else if (child.type === "spread_element") {
          hasSpread = true;
          const source = child.namedChildren[0];
          properties.push({
            path: prefix.length > 0 ? [...prefix] : [],
            valueKind: "spread",
            spreadSource: source?.text ?? "",
            range: this.range(child)
          });
        } else if (child.type === "method_definition") {
          const key = fieldName(child, "name") ?? fieldName(child, "key");
          if (key) properties.push({ path: [...prefix, key.text], valueKind: "function", range: this.range(child) });
        }
      }
    };
    collect(node, [], 0);
    const record: ObjectLiteralRecord = { id, range: this.range(node), properties, hasSpread };
    this.objects.set(id, record);
    return record;
  }

  // -- property access chains ----------------------------------------------

  private collectAccess(node: Parser.SyntaxNode, scopeId: string, ctx: WalkContext): void {
    // Only record the outermost member chain (inner links are part of it).
    if (node.parent?.type === "member_expression") return;
    if (node.parent?.type === "subscript_expression" && node.type === "member_expression") return;
    const chain = flattenAccessChain(node);
    if (chain === null || chain.segments.length === 0 || chain.root === undefined) return;
    this.accesses.push({
      rootIdentifier: chain.root,
      segments: chain.segments,
      range: this.range(node),
      scopeId,
      enclosingSymbolId: ctx.function?.id
    });
  }

  // -- helpers --------------------------------------------------------------

  private range(node: Parser.SyntaxNode): Range {
    return {
      startLine: node.startPosition.row,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row,
      endColumn: node.endPosition.column
    };
  }
}

interface WalkContext {
  insideAwait: boolean;
  function?: { id: string; name: string };
  /** Names of the variable declarator currently being walked (`const x = …`). */
  declaratorNames?: ReadonlyArray<string>;
  /**
   * Identifier the declarator's init value is assigned to
   * (`const res = await api.get(…)` → "res"). Consumed by collectCall to stamp
   * `assignsTo` on exactly the call whose result the variable binds — cleared
   * before arguments are descended so nested calls do not inherit it.
   */
  assigningTo?: string;
}

/** One binding introduced by an object destructuring pattern. */
export interface DestructuringAlias {
  readonly name: string;
  /** Text of the destructured source expression (`res.data`). */
  readonly sourceText: string;
  /** Property path this binding aliases (`["user"]` for `{ user: u }`). */
  readonly path: ReadonlyArray<string>;
  /** True for rest elements (`...others`) — unknown remaining properties. */
  readonly rest: boolean;
  readonly scopeId: string;
}

/** Bindings of an object destructuring pattern with their property paths. */
export function objectPatternBindings(pattern: Parser.SyntaxNode): Array<{ localName: string; path: string[]; rest: boolean }> {
  const bindings: Array<{ localName: string; path: string[]; rest: boolean }> = [];
  for (const child of pattern.namedChildren) {
    if (child.type === "shorthand_property_identifier_pattern") {
      bindings.push({ localName: child.text, path: [child.text], rest: false });
    } else if (child.type === "pair") {
      const key = fieldName(child, "key");
      const value = fieldName(child, "value");
      if (!key || !value) continue;
      const keyText = key.type === "string" ? stringValue(key) : key.text;
      if (value.type === "identifier") {
        bindings.push({ localName: value.text, path: [keyText], rest: false });
      } else if (value.type === "object_pattern") {
        for (const nested of objectPatternBindings(value)) {
          bindings.push({ localName: nested.localName, path: [keyText, ...nested.path], rest: nested.rest });
        }
      }
    } else if (child.type === "rest_pattern") {
      const inner = child.namedChildren[0];
      if (inner) bindings.push({ localName: inner.text, path: [], rest: true });
    }
  }
  return bindings;
}

const DECLARATION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "lexical_declaration",
  "variable_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "internal_module",
  "module"
]);

function fieldName(node: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  return node.childForFieldName(name);
}

function boundText(node: Parser.SyntaxNode, max = MAX_TEXT): string {
  const text = node.text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Content of a `string` node with common escapes processed. */
export function stringValue(node: Parser.SyntaxNode): string {
  const fragments: string[] = [];
  const visit = (n: Parser.SyntaxNode): void => {
    if (n.type === "string_fragment") {
      fragments.push(n.text);
      return;
    }
    if (n.type === "escape_sequence") {
      fragments.push(n.text.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t"));
      return;
    }
    for (const child of n.namedChildren) visit(child);
  };
  visit(node);
  return fragments
    .join("")
    .replace(/\\(['"`\\])/g, "$1")
    .replace(/\\\//g, "/");
}

/** Template literal → static/expression parts. */
export function templateParts(node: Parser.SyntaxNode): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let staticRun = "";
  for (const child of node.namedChildren) {
    if (child.type === "string_fragment") {
      staticRun += child.text;
    } else if (child.type === "template_substitution") {
      if (staticRun !== "") parts.push({ kind: "static", text: staticRun });
      staticRun = "";
      // child.text includes the `${...}` wrapper; store the inner expression.
      const inner = child.text.startsWith("${") && child.text.endsWith("}")
        ? child.text.slice(2, -1)
        : child.text;
      parts.push({ kind: "expression", text: inner });
    } else if (child.type === "escape_sequence") {
      staticRun += child.text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    }
  }
  if (staticRun !== "") parts.push({ kind: "static", text: staticRun });
  return parts;
}

/** Flatten `"a" + x + "/b"` trees into string parts; null when not a concat. */
export function flattenConcat(node: Parser.SyntaxNode): StringPart[] | null {
  if (node.type === "binary_expression") {
    const operatorNode = node.children.find((c) => !c.type.startsWith("_") && c.text === "+");
    if (!operatorNode) return null;
    const left = fieldName(node, "left");
    const right = fieldName(node, "right");
    if (!left || !right) return null;
    const leftParts = flattenConcat(left);
    const rightParts = flattenConcat(right);
    if (leftParts === null || rightParts === null) return null;
    return [...leftParts, ...rightParts];
  }
  if (node.type === "parenthesized_expression") {
    const inner = node.namedChildren[0];
    return inner ? flattenConcat(inner) : null;
  }
  if (node.type === "string") return [{ kind: "static", text: stringValue(node) }];
  if (node.type === "template_string") {
    return templateParts(node).map((p): StringPart => (p.kind === "static" ? p : { kind: "expression", text: p.text }));
  }
  return [{ kind: "expression", text: boundText(node) }];
}

/** Callee chain: identifier segments of a call target. */
export function flattenCalleeChain(node: Parser.SyntaxNode): { segments: ChainSegment[]; root?: string } {
  if (node.type === "identifier") {
    // Bare call: the root identifier carries the name; segments stay empty so
    // member chains and bare calls have uniform shape (root + property segments).
    return { segments: [], root: node.text };
  }
  if (node.type === "member_expression" || node.type === "subscript_expression") {
    const chain = flattenAccessChain(node);
    if (chain === null) return { segments: [{ text: boundText(node, 60), optional: false, computed: true }] };
    return { segments: chain.segments, root: chain.root };
  }
  if (node.type === "parenthesized_expression") {
    const inner = node.namedChildren[0];
    return inner ? flattenCalleeChain(inner) : { segments: [] };
  }
  return { segments: [{ text: boundText(node, 60), optional: false, computed: true }] };
}

/** Flatten `root.a?.b["c"]` into segments. Returns null for exotic roots. */
export function flattenAccessChain(node: Parser.SyntaxNode): { segments: ChainSegment[]; root?: string } | null {
  if (node.type === "identifier") {
    return { segments: [], root: node.text };
  }
  if (node.type === "member_expression") {
    const object = fieldName(node, "object");
    const property = fieldName(node, "property");
    if (!object || !property) return null;
    const base = flattenAccessChain(object);
    if (base === null) return null;
    const optional = node.namedChildren.some((c) => c.type === "optional_chain");
    const segments = [...base.segments, { text: property.text, optional, computed: false }];
    return { segments, root: base.root };
  }
  if (node.type === "subscript_expression") {
    const object = fieldName(node, "object");
    const index = fieldName(node, "index");
    if (!object) return null;
    const base = flattenAccessChain(object);
    if (base === null) return null;
    if (index && index.type === "string") {
      return { segments: [...base.segments, { text: stringValue(index), optional: false, computed: true }], root: base.root };
    }
    // Non-literal index: the chain beyond this point is dynamic.
    return { segments: [...base.segments, { text: "<dynamic>", optional: false, computed: true }], root: base.root };
  }
  if (node.type === "parenthesized_expression") {
    const inner = node.namedChildren[0];
    return inner ? flattenAccessChain(inner) : null;
  }
  return null;
}

/** All binding names introduced by a variable-declarator name node. */
export function patternBindingNames(node: Parser.SyntaxNode): string[] {
  switch (node.type) {
    case "identifier":
      return [node.text];
    case "object_pattern": {
      const names: string[] = [];
      for (const child of node.namedChildren) {
        if (child.type === "shorthand_property_identifier_pattern") names.push(child.text);
        else if (child.type === "pair") {
          const value = fieldName(child, "value");
          if (value) names.push(...patternBindingNames(value));
        } else if (child.type === "rest_pattern") {
          const inner = child.namedChildren[0];
          if (inner) names.push(...patternBindingNames(inner));
        } else if (child.type === "assignment_pattern") {
          const left = fieldName(child, "left");
          if (left) names.push(...patternBindingNames(left));
        }
      }
      return names;
    }
    case "array_pattern": {
      const names: string[] = [];
      for (const child of node.namedChildren) names.push(...patternBindingNames(child));
      return names;
    }
    case "rest_pattern": {
      const inner = node.namedChildren[0];
      return inner ? patternBindingNames(inner) : [];
    }
    case "assignment_pattern": {
      const left = fieldName(node, "left");
      return left ? patternBindingNames(left) : [];
    }
    default:
      return [];
  }
}

/** `: Type` annotation text under a declaration node, if any. */
export function findTypeAnnotationText(node: Parser.SyntaxNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === "type_annotation") {
      const typeNode = child.namedChildren[0];
      return typeNode ? boundText(typeNode, 120) : undefined;
    }
  }
  return undefined;
}

/** Return-type annotation of a function/method node. */
export function findReturnTypeAnnotation(node: Parser.SyntaxNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === "type_annotation" && child.parent === node) {
      const typeNode = child.namedChildren[0];
      return typeNode ? boundText(typeNode, 120) : undefined;
    }
  }
  return undefined;
}

/** Flattened member paths of an interface / object type alias. */
export function collectTypeMembers(node: Parser.SyntaxNode): TypeMember[] {
  const members: TypeMember[] = [];
  const visit = (n: Parser.SyntaxNode, prefix: ReadonlyArray<string>, depth: number): void => {
    if (depth > 8) return;
    for (const child of n.namedChildren) {
      if (child.type === "property_signature") {
        const key = fieldName(child, "name") ?? fieldName(child, "property");
        if (!key) continue;
        const path = [...prefix, key.text];
        members.push({ name: key.text, path });
        const annotation = fieldName(child, "type");
        if (annotation && (annotation.type === "object_type")) {
          visit(annotation, path, depth + 1);
        }
      } else if (child.type === "object_type") {
        visit(child, prefix, depth + 1);
      }
    }
  };
  visit(node, [], 0);
  return members;
}

function byScopePath(a: Scope, b: Scope): number {
  const len = Math.min(a.path.length, b.path.length);
  for (let i = 0; i < len; i++) {
    if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
  }
  return a.path.length - b.path.length;
}
