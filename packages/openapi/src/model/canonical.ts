import type { HttpMethod } from "../interfaces.js";

/**
 * Tern's canonical OpenAPI model.
 *
 * This is a *semantic* view of a document: syntactically irrelevant differences
 * (key order, method casing, `nullable: true` vs `type: [..., "null"]`, an inline
 * schema vs a `$ref` to an identical component) are normalised away, while
 * everything a migration needs — names, operation ids, status codes, enum values,
 * required flags, provenance — is preserved.
 *
 * ## Why schemas are a registry rather than a tree
 *
 * `$ref` targets are *not* inlined. Every schema, whether a component or an inline
 * definition, is registered under a canonical id (its JSON pointer) and referenced by
 * that id. This gives three properties at once:
 *
 *  1. **Termination.** Recursive schemas (`Node -> Node`, `A -> B -> A`) are ordinary
 *     finite graphs; nothing needs to expand them.
 *  2. **Provenance.** The id *is* the origin. A schema referenced from two operations
 *     keeps the id `#/components/schemas/User`, so the diff can report "User changed"
 *     while still attributing the consequence to each operation that uses it.
 *  3. **Determinism.** Ids are derived from the document structure, never generated.
 */

/** Canonical id of a schema: an RFC 6901 JSON pointer rooted at the document. */
export type SchemaId = string;

/** Compatibility direction. A change can affect requests, responses, or both. */
export const DIRECTIONS = ["request", "response", "both", "unknown"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export type SchemaOrigin =
  /** Declared under `components/schemas`. Shared, named, and referenced by name. */
  | { kind: "component"; name: string }
  /** Declared inline at a specific location in the document. */
  | { kind: "inline"; pointer: string }
  /** A `$ref` Tern refuses to follow (external file or URL). Never fetched. */
  | { kind: "external"; ref: string };

/**
 * Keywords Tern recognises but does not reason about. Their presence downgrades
 * confidence rather than being silently ignored.
 */
export type UnsupportedKeyword =
  | "not"
  | "discriminator"
  | "patternProperties"
  | "dependentSchemas"
  | "if"
  | "then"
  | "else"
  | "prefixItems"
  | "contains"
  | "unevaluatedProperties"
  | "external-ref";

export interface NumericConstraints {
  minimum?: number;
  maximum?: number;
  /** Normalised to a number. OpenAPI 3.0 booleans are folded into the bound. */
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

export interface StringConstraints {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface ArrayConstraints {
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface SchemaNode {
  readonly id: SchemaId;
  readonly origin: SchemaOrigin;
  /**
   * JSON Schema types, sorted and de-duplicated. Empty means "unspecified", which is
   * semantically different from `type: "object"` and is preserved as such.
   * OpenAPI 3.1 type arrays and 3.0 `nullable` both normalise into this list.
   */
  readonly types: readonly string[];
  /** True when `null` is a permitted value, however it was expressed. */
  readonly nullable: boolean;
  readonly format?: string;
  /** Enum values, canonically sorted. Enum *order* carries no meaning. */
  readonly enum?: readonly unknown[];
  readonly const?: { value: unknown };
  readonly properties: ReadonlyMap<string, SchemaId>;
  readonly required: ReadonlySet<string>;
  /** `undefined` means the keyword is absent (JSON Schema default: permissive). */
  readonly additionalProperties: boolean | SchemaId | undefined;
  readonly items?: SchemaId;
  readonly oneOf?: readonly SchemaId[];
  readonly anyOf?: readonly SchemaId[];
  readonly allOf?: readonly SchemaId[];
  readonly numeric: NumericConstraints;
  readonly string: StringConstraints;
  readonly array: ArrayConstraints;
  readonly default?: { value: unknown };
  readonly readOnly: boolean;
  readonly writeOnly: boolean;
  readonly deprecated: boolean;
  /** Recognised-but-unanalysed keywords present on this schema. */
  readonly unsupported: readonly UnsupportedKeyword[];
  /**
   * Canonical encoding of the unsupported keywords' values.
   *
   * Tern cannot reason about `not`, `if`/`then`, `patternProperties` and friends, but
   * it can still detect that one of them *changed* and report that explicitly as
   * UNKNOWN rather than pretending the schemas are equivalent.
   */
  readonly unsupportedSignature?: string;
}

export interface SchemaRegistry {
  get(id: SchemaId): SchemaNode | undefined;
  has(id: SchemaId): boolean;
  ids(): readonly SchemaId[];
}

export interface ApiParameter {
  readonly name: string;
  readonly in: "query" | "path" | "header" | "cookie";
  readonly required: boolean;
  readonly deprecated: boolean;
  readonly schema?: SchemaId;
  /** Content-typed parameters (`content` instead of `schema`). */
  readonly contentMediaType?: string;
  readonly pointer: string;
}

export interface ApiMediaType {
  readonly mediaType: string;
  readonly schema?: SchemaId;
  readonly pointer: string;
}

export interface ApiRequestBody {
  readonly required: boolean;
  readonly content: readonly ApiMediaType[];
  readonly pointer: string;
}

export interface ApiResponse {
  readonly statusCode: string;
  readonly content: readonly ApiMediaType[];
  readonly headerNames: readonly string[];
  readonly pointer: string;
}

export interface ApiOperation {
  /** Stable identity: `${METHOD} ${path}`. Never derived from operationId. */
  readonly key: string;
  readonly path: string;
  readonly method: HttpMethod;
  readonly operationId?: string;
  readonly deprecated: boolean;
  readonly tags: readonly string[];
  /** Path-level and operation-level parameters, merged and sorted by (in, name). */
  readonly parameters: readonly ApiParameter[];
  readonly requestBody?: ApiRequestBody;
  /** Sorted by status code, with `default` last. */
  readonly responses: readonly ApiResponse[];
  /** Effective security requirements (operation-level overrides document-level). */
  readonly security?: readonly (readonly string[])[];
  readonly pointer: string;
}

/** A construct Tern could not analyse, surfaced instead of being silently dropped. */
export interface UnsupportedFeature {
  readonly pointer: string;
  readonly feature: string;
  readonly detail: string;
}

export interface ApiModel {
  /** The `openapi` field verbatim, e.g. `3.0.3`. */
  readonly openapiVersion: string;
  /** Coarse version family Tern analyses against. */
  readonly specVersion: "3.0" | "3.1";
  readonly title: string;
  readonly version: string;
  readonly serverUrls: readonly string[];
  /** Sorted by `${method} ${path}` so iteration order is deterministic. */
  readonly operations: readonly ApiOperation[];
  readonly componentSchemaNames: readonly string[];
  readonly registry: SchemaRegistry;
  readonly securitySchemeNames: readonly string[];
  readonly unsupported: readonly UnsupportedFeature[];
}

/** Look up a schema, or throw if the model is internally inconsistent. */
export function requireSchema(registry: SchemaRegistry, id: SchemaId): SchemaNode {
  const node = registry.get(id);
  if (!node) {
    throw new Error(`Internal error: schema id not present in registry: ${id}`);
  }
  return node;
}
