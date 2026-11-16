/**
 * Canonical scanner model.
 *
 * Everything the scanner learns about a repository is expressed in these
 * structures. The model is produced deterministically: same repository bytes
 * plus same OpenAPI analysis yield byte-identical results. Identifiers are
 * content- and coordinate-derived (sha256), never random.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary (kept aligned with @capibara/openapi)
// ---------------------------------------------------------------------------

/** Deterministic confidence levels, matching the OpenAPI engine vocabulary. */
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export type Severity = "BREAKING" | "CONDITIONAL" | "NON_BREAKING" | "UNKNOWN";

/** A single reason the scanner believes something. Evidence always travels with conclusions. */
export interface Evidence {
  /** Machine-readable evidence kind, e.g. `symbol-resolved`, `path-literal`. */
  readonly kind: string;
  /** Human-readable explanation, stable in wording. */
  readonly detail: string;
  readonly confidence: Confidence;
}

export interface Range {
  /** Zero-based line. */
  readonly startLine: number;
  /** Zero-based column. */
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

// ---------------------------------------------------------------------------
// Files and discovery
// ---------------------------------------------------------------------------

export interface SourceFile {
  /** Repo-relative POSIX path; also used as the stable module/file id. */
  readonly id: string;
  readonly sizeBytes: number;
  /** Content hash (sha256, hex) of the exact bytes analysed. */
  readonly hash: string;
  /** File carries an explicit `@generated`/`@ Generated` marker. */
  readonly generated: boolean;
  /** `.d.ts` declaration file: parsed for types, contains no runtime code. */
  readonly declarationOnly: boolean;
  /** Either a full parse, a parse with errors, or a file we refused to parse. */
  readonly parse: ParseOutcome;
}

export type ParseOutcome =
  | { readonly ok: true; readonly nodeCount: number }
  | { readonly ok: false; readonly partial: boolean; readonly errors: readonly ParseDiagnostic[] }
  | { readonly refused: true; readonly reason: string };

export interface ParseDiagnostic {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Why a file was not included in the scan. Discovery records every exclusion so
 * results can be audited; nothing is skipped silently.
 */
export type ExclusionReason =
  | "default-ignored"
  | "gitignored"
  | "user-excluded"
  | "not-included"
  | "symlink-escape"
  | "symlink-loop"
  | "oversized"
  | "binary"
  | "file-limit"
  | "depth-limit"
  | "unreadable"
  | "duplicate";

export interface ExcludedFile {
  readonly path: string;
  readonly reason: ExclusionReason;
}

// ---------------------------------------------------------------------------
// Modules, imports, exports
// ---------------------------------------------------------------------------

/** Resolution outcome for one import specifier. */
export type ResolvedImport =
  | { readonly kind: "internal"; readonly moduleId: string }
  | { readonly kind: "external"; readonly packageName: string }
  | { readonly kind: "unresolved"; readonly reason: UnresolvedReason };

export type UnresolvedReason =
  | "package-not-installed"
  | "path-not-found"
  | "unresolvable-specifier"
  | "resolution-budget-exhausted";

export interface ImportRecord {
  readonly specifier: string;
  readonly resolved: ResolvedImport;
  readonly defaultLocal?: string;
  readonly namespaceLocal?: string;
  /** Named imports: imported exported name -> local binding name. */
  readonly named: ReadonlyArray<{ readonly imported: string; readonly local: string }>;
  readonly sideEffectOnly: boolean;
  readonly typeOnly: boolean;
  readonly range: Range;
}

export interface ExportRecord {
  /** Exported name; `"default"` for default exports; `"*"` for star re-exports. */
  readonly name: string;
  /** Local declaration name backing the export, when defined in this module. */
  readonly localName?: string;
  /** Raw specifier for re-exports (`export { x } from "./m"`). */
  readonly fromSpecifier?: string;
  readonly range: Range;
}

// ---------------------------------------------------------------------------
// Symbols and scopes
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "variable"
  | "parameter"
  | "type-alias"
  | "interface"
  | "enum"
  | "namespace"
  | "import";

export type ScopeKind = "module" | "function" | "block" | "class";

export interface Scope {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly parent?: string;
  /** Ordinal among the scope's siblings, for deterministic ids. */
  readonly path: ReadonlyArray<number>;
  readonly range: Range;
}

/**
 * How a variable was initialised. Drives value reconstruction and client
 * instance tracking (e.g. `const api = axios.create(...)`) without executing
 * anything.
 */
export type VariableInit =
  | { readonly kind: "uninitialized" }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "template"; readonly parts: ReadonlyArray<TemplatePart> }
  | { readonly kind: "binary-concat"; readonly parts: ReadonlyArray<StringPart> }
  | { readonly kind: "identifier"; readonly target: string }
  | {
    readonly kind: "call";
    readonly calleeText: string;
    readonly argTexts: ReadonlyArray<string>;
    /** Object-literal record ids for object arguments, aligned with arg positions (-1 when absent). */
    readonly argObjectIds?: ReadonlyArray<string>;
  }
  | { readonly kind: "object-literal" }
  | { readonly kind: "arrow-or-function" }
  | { readonly kind: "class-expression" }
  | { readonly kind: "other"; readonly text: string };

export type TemplatePart =
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "expression"; readonly text: string };

export type StringPart =
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "expression"; readonly text: string };

export interface TypeMember {
  readonly name: string;
  readonly path: ReadonlyArray<string>;
}

export interface SymbolDeclaration {
  /** Stable id: `<file>#<scopePath>#<name>#<ordinal>`. */
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly scopeId: string;
  readonly range: Range;
  readonly exported: boolean;
  /** For import declarations: where the symbol comes from. */
  readonly importOf?: {
    readonly moduleId: string | undefined;
    readonly specifier: string;
    readonly importedName: string | undefined;
    readonly importKind: "default" | "named" | "namespace";
  };
  readonly init?: VariableInit;
  /** Raw type annotation text, when present (`: Charge`, `as Charge`, `Promise<Charge>`). */
  readonly typeAnnotation?: string;
  /** Flattened property names for interface/type-alias declarations. */
  readonly typeMembers?: ReadonlyArray<TypeMember>;
}

// ---------------------------------------------------------------------------
// Calls, objects, accesses
// ---------------------------------------------------------------------------

/** One dotted segment of a callee or access chain. */
export interface ChainSegment {
  readonly text: string;
  readonly optional: boolean;
  /** True when the segment came from a computed access like `obj["get"]`. */
  readonly computed: boolean;
}

export type ArgumentShape =
  | { readonly kind: "string-literal"; readonly value: string }
  | { readonly kind: "template"; readonly parts: ReadonlyArray<TemplatePart> }
  | { readonly kind: "binary-concat"; readonly parts: ReadonlyArray<StringPart> }
  | { readonly kind: "identifier"; readonly name: string }
  | { readonly kind: "object"; readonly objectId: string }
  | { readonly kind: "spread"; readonly text: string }
  | { readonly kind: "arrow-or-function" }
  | { readonly kind: "other"; readonly text: string };

export interface CallRecord {
  /** Stable id: `<file>#call#<startLine>:<startColumn>`. */
  readonly id: string;
  readonly range: Range;
  /** Dotted callee chain (`axios.post` → axios, post). */
  readonly callee: ReadonlyArray<ChainSegment>;
  /** Identifier the callee chain starts from, if it starts with one. */
  readonly rootIdentifier?: string;
  readonly args: ReadonlyArray<ArgumentShape>;
  readonly awaited: boolean;
  readonly insideAwait: boolean;
  /** Local variable the call's result is assigned to, when statically visible (`const x = await call()`). */
  readonly assignsTo?: string;
  /** Enclosing named function/method/arrow symbol, when one exists. */
  readonly enclosingSymbolId?: string;
  readonly enclosingFunctionName?: string;
  readonly scopeId: string;
}

/** One property of an object literal, with its full nested path. */
export interface ObjectProperty {
  /** Dotted path within the object (`user.profile.email`). */
  readonly path: ReadonlyArray<string>;
  readonly valueKind:
    | "shorthand"
    | "literal"
    | "template"
    | "identifier"
    | "object"
    | "spread"
    | "computed"
    | "json-stringify"
    | "function"
    | "other";
  /** For spreads: the spread source text (`...user` → `user`). */
  readonly spreadSource?: string;
  /** For literal values: the processed string content. */
  readonly literalValue?: string;
  /** For template values: the template parts. */
  readonly templateValue?: ReadonlyArray<TemplatePart>;
  /** For `object` and `json-stringify` values: the nested object record id. */
  readonly nestedObjectId?: string;
  readonly range: Range;
}

export interface ObjectLiteralRecord {
  readonly id: string;
  readonly range: Range;
  readonly properties: ReadonlyArray<ObjectProperty>;
  readonly hasSpread: boolean;
}

/** A property access chain rooted at an identifier: `response.data.user.email`. */
export interface AccessRecord {
  readonly rootIdentifier: string;
  readonly segments: ReadonlyArray<ChainSegment>;
  readonly range: Range;
  readonly scopeId: string;
  readonly enclosingSymbolId?: string;
}

// ---------------------------------------------------------------------------
// OpenAPI linkage (input contract from Turn 2)
// ---------------------------------------------------------------------------

/**
 * Identity of one OpenAPI operation. `method` is upper-case; `path` is the
 * raw template (`/users/{id}`).
 */
export interface OperationKey {
  readonly path: string;
  readonly method: string;
  readonly operationId?: string;
}

export function operationKeyString(key: OperationKey): string {
  return `${key.method} ${key.path}`;
}
