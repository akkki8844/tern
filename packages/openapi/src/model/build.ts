import { OpenAPIError } from "@tern/shared";
import { HTTP_METHODS, type HttpMethod, type OpenApiDocument } from "../interfaces.js";
import { Budget, DEFAULT_LIMITS, assertDepth, type AnalysisLimits } from "../limits.js";
import { classifyRef, followRef, pointer } from "./refs.js";
import type {
  ApiMediaType,
  ApiModel,
  ApiOperation,
  ApiParameter,
  ApiRequestBody,
  ApiResponse,
  ArrayConstraints,
  NumericConstraints,
  SchemaId,
  SchemaNode,
  SchemaOrigin,
  SchemaRegistry,
  StringConstraints,
  UnsupportedFeature,
  UnsupportedKeyword
} from "./canonical.js";

export interface BuildOptions {
  limits?: AnalysisLimits;
}

/** Model plus the component-name index, which the diff engine needs. */
export interface BuiltModel extends ApiModel {
  readonly componentSchemas: ReadonlyMap<string, SchemaId>;
}

const UNSUPPORTED_SCHEMA_KEYWORDS: readonly UnsupportedKeyword[] = [
  "not",
  "discriminator",
  "patternProperties",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "prefixItems",
  "contains",
  "unevaluatedProperties"
];

/**
 * Build the canonical model from a parsed OpenAPI document.
 *
 * The builder is total: it either produces a complete model or throws a typed
 * `OpenAPIError`. It never returns a partially-understood model, because a silently
 * incomplete model produces silently incomplete diffs.
 */
export function buildApiModel(document: OpenApiDocument, options: BuildOptions = {}): BuiltModel {
  return new ModelBuilder(document, options.limits ?? DEFAULT_LIMITS).build();
}

class ModelBuilder {
  private readonly nodes = new Map<SchemaId, SchemaNode>();
  private readonly inProgress = new Set<SchemaId>();
  private readonly unsupported: UnsupportedFeature[] = [];
  private readonly nodeBudget: Budget;
  private readonly raw: Record<string, unknown>;
  private readonly specVersion: "3.0" | "3.1";

  constructor(
    private readonly document: OpenApiDocument,
    private readonly limits: AnalysisLimits
  ) {
    this.raw = document as unknown as Record<string, unknown>;
    this.nodeBudget = new Budget(limits.maxModelNodes, "model node", "OPENAPI_MODEL_TOO_LARGE");
    this.specVersion = document.openapi.startsWith("3.1") ? "3.1" : "3.0";
  }

  build(): BuiltModel {
    const componentSchemas = this.buildComponentSchemas();
    const operations = this.buildOperations();

    const registry: SchemaRegistry = {
      get: (id) => this.nodes.get(id),
      has: (id) => this.nodes.has(id),
      ids: () => [...this.nodes.keys()].sort()
    };

    return {
      openapiVersion: this.document.openapi,
      specVersion: this.specVersion,
      title: this.document.info?.title ?? "",
      version: this.document.info?.version ?? "",
      serverUrls: (this.document.servers ?? []).map((s) => s.url).filter((u) => typeof u === "string"),
      operations,
      componentSchemas,
      componentSchemaNames: [...componentSchemas.keys()].sort(),
      registry,
      securitySchemeNames: Object.keys(this.document.components?.securitySchemes ?? {}).sort(),
      unsupported: this.unsupported
    };
  }

  // -------------------------------------------------------------------------
  // Components
  // -------------------------------------------------------------------------

  private buildComponentSchemas(): Map<string, SchemaId> {
    const componentsNode = record(this.raw.components);
    const schemas = record(componentsNode?.schemas);
    const result = new Map<string, SchemaId>();
    if (!schemas) return result;

    const names = Object.keys(schemas).sort();
    if (names.length > this.limits.maxComponentSchemas) {
      throw new OpenAPIError(`Document declares more than ${this.limits.maxComponentSchemas} component schemas`, {
        code: "OPENAPI_TOO_MANY_SCHEMAS",
        details: { count: names.length }
      });
    }

    for (const name of names) {
      const target = pointer("#", "components", "schemas", name);
      const id = this.resolveSchema(schemas[name], target, 0);
      result.set(name, id);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  private buildOperations(): ApiOperation[] {
    const paths = record(this.raw.paths) ?? {};
    const operations: ApiOperation[] = [];
    const operationIds = new Map<string, string>();

    for (const path of Object.keys(paths).sort()) {
      if (!path.startsWith("/")) {
        throw new OpenAPIError(`Path must start with "/": ${path}`, {
          code: "OPENAPI_PATH_INVALID",
          details: { path }
        });
      }
      const pathPointer = pointer("#", "paths", path);
      const item = this.dereference(paths[path], pathPointer);
      if (!item) continue;

      const pathParameters = this.buildParameters(item.parameters, pointer(pathPointer, "parameters"));

      for (const method of HTTP_METHODS) {
        const rawOperation = record(item[method]);
        if (!rawOperation) continue;
        this.nodeBudget.spend();

        const opPointer = pointer(pathPointer, method);
        const operationParameters = this.buildParameters(rawOperation.parameters, pointer(opPointer, "parameters"));
        const parameters = mergeParameters(pathParameters, operationParameters, opPointer);

        const operationId = typeof rawOperation.operationId === "string" ? rawOperation.operationId : undefined;
        if (operationId !== undefined) {
          const existing = operationIds.get(operationId);
          if (existing) {
            // The specification requires operationId to be unique. Two operations
            // sharing one would make every identity-based diff ambiguous, so this is
            // rejected rather than resolved by guessing.
            throw new OpenAPIError(`Duplicate operationId "${operationId}"`, {
              code: "OPENAPI_DUPLICATE_OPERATION_ID",
              details: { operationId, first: existing, second: `${method.toUpperCase()} ${path}` },
              publicMessage: "The OpenAPI document declares the same operationId more than once."
            });
          }
          operationIds.set(operationId, `${method.toUpperCase()} ${path}`);
        }

        operations.push({
          key: `${method.toUpperCase()} ${path}`,
          path,
          method: method as HttpMethod,
          operationId,
          deprecated: rawOperation.deprecated === true,
          tags: stringArray(rawOperation.tags).sort(),
          parameters,
          requestBody: this.buildRequestBody(rawOperation.requestBody, pointer(opPointer, "requestBody")),
          responses: this.buildResponses(rawOperation.responses, pointer(opPointer, "responses")),
          security: this.buildSecurity(rawOperation.security ?? this.raw.security),
          pointer: opPointer
        });

        if (operations.length > this.limits.maxOperations) {
          throw new OpenAPIError(`Document declares more than ${this.limits.maxOperations} operations`, {
            code: "OPENAPI_TOO_MANY_OPERATIONS",
            details: { limit: this.limits.maxOperations }
          });
        }
      }
    }

    operations.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return operations;
  }

  private buildParameters(rawList: unknown, basePointer: string): ApiParameter[] {
    if (rawList === undefined) return [];
    if (!Array.isArray(rawList)) {
      throw new OpenAPIError("parameters must be an array", {
        code: "OPENAPI_PARAMETERS_INVALID",
        details: { pointer: basePointer }
      });
    }

    const seen = new Set<string>();
    const parameters: ApiParameter[] = [];

    rawList.forEach((entry, index) => {
      const paramPointer = pointer(basePointer, index);
      const param = this.dereference(entry, paramPointer);
      if (!param) return;
      this.nodeBudget.spend();

      const name = param.name;
      const location = param.in;
      if (typeof name !== "string" || typeof location !== "string") {
        throw new OpenAPIError("Parameter requires both `name` and `in`", {
          code: "OPENAPI_PARAMETER_INVALID",
          details: { pointer: paramPointer }
        });
      }
      if (!["query", "path", "header", "cookie"].includes(location)) {
        throw new OpenAPIError(`Unknown parameter location "${location}"`, {
          code: "OPENAPI_PARAMETER_LOCATION_INVALID",
          details: { pointer: paramPointer, in: location }
        });
      }

      const key = `${location}:${name}`;
      if (seen.has(key)) {
        throw new OpenAPIError(`Duplicate parameter "${name}" in "${location}"`, {
          code: "OPENAPI_DUPLICATE_PARAMETER",
          details: { pointer: paramPointer, name, in: location }
        });
      }
      seen.add(key);

      // A path parameter is always required; the spec makes the flag redundant there.
      const required = location === "path" ? true : param.required === true;

      let schema: SchemaId | undefined;
      let contentMediaType: string | undefined;
      if (param.schema !== undefined) {
        schema = this.resolveSchema(param.schema, pointer(paramPointer, "schema"), 0);
      } else if (record(param.content)) {
        const content = record(param.content)!;
        const mediaTypes = Object.keys(content).sort();
        contentMediaType = mediaTypes[0];
        if (contentMediaType) {
          const media = record(content[contentMediaType]);
          if (media?.schema !== undefined) {
            schema = this.resolveSchema(
              media.schema,
              pointer(paramPointer, "content", contentMediaType, "schema"),
              0
            );
          }
        }
      }

      parameters.push({
        name,
        in: location as ApiParameter["in"],
        required,
        deprecated: param.deprecated === true,
        schema,
        contentMediaType,
        pointer: paramPointer
      });
    });

    return parameters;
  }

  private buildRequestBody(rawBody: unknown, basePointer: string): ApiRequestBody | undefined {
    if (rawBody === undefined) return undefined;
    const body = this.dereference(rawBody, basePointer);
    if (!body) return undefined;
    this.nodeBudget.spend();
    return {
      required: body.required === true,
      content: this.buildContent(body.content, pointer(basePointer, "content")),
      pointer: basePointer
    };
  }

  private buildResponses(rawResponses: unknown, basePointer: string): ApiResponse[] {
    const responses = record(rawResponses);
    if (!responses) return [];
    const result: ApiResponse[] = [];

    for (const statusCode of Object.keys(responses).sort(compareStatusCodes)) {
      const responsePointer = pointer(basePointer, statusCode);
      const response = this.dereference(responses[statusCode], responsePointer);
      if (!response) continue;
      this.nodeBudget.spend();
      result.push({
        statusCode,
        content: this.buildContent(response.content, pointer(responsePointer, "content")),
        headerNames: Object.keys(record(response.headers) ?? {}).sort(),
        pointer: responsePointer
      });
    }
    return result;
  }

  private buildContent(rawContent: unknown, basePointer: string): ApiMediaType[] {
    const content = record(rawContent);
    if (!content) return [];
    return Object.keys(content)
      .sort()
      .map((mediaType) => {
        const mediaPointer = pointer(basePointer, mediaType);
        const media = record(content[mediaType]);
        const schema =
          media?.schema !== undefined
            ? this.resolveSchema(media.schema, pointer(mediaPointer, "schema"), 0)
            : undefined;
        return { mediaType, schema, pointer: mediaPointer };
      });
  }

  private buildSecurity(rawSecurity: unknown): string[][] | undefined {
    if (!Array.isArray(rawSecurity)) return undefined;
    return rawSecurity
      .map((entry) => Object.keys(record(entry) ?? {}).sort())
      .sort((a, b) => (a.join(",") < b.join(",") ? -1 : 1));
  }

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  /**
   * Resolve a schema position to a canonical id, registering the node if needed.
   *
   * A `$ref` resolves to the id of its *target*, which is what preserves provenance:
   * ten operations referencing `User` all yield `#/components/schemas/User`.
   */
  private resolveSchema(rawSchema: unknown, fallbackPointer: string, depth: number): SchemaId {
    assertDepth(depth, this.limits);
    const schema = record(rawSchema);
    if (!schema) {
      // `true` / `false` / absent schemas: model as an unconstrained node so callers
      // never have to special-case them.
      return this.registerNode(fallbackPointer, { kind: "inline", pointer: fallbackPointer }, {}, depth);
    }

    const ref = schema.$ref;
    if (typeof ref === "string") {
      const classified = classifyRef(ref);
      if (classified.kind === "external") {
        this.unsupported.push({
          pointer: fallbackPointer,
          feature: "external-$ref",
          detail: `Tern does not resolve external references (${classified.reason}); this schema is treated as opaque.`
        });
        return this.registerExternal(fallbackPointer, ref);
      }

      const resolved = followRef(this.raw, ref, this.limits.maxRefChain);
      if (!resolved) return this.registerExternal(fallbackPointer, ref);

      const targetId = this.registerFromPointer(resolved.pointer, resolved.target, depth);

      // OpenAPI 3.1 permits keywords alongside `$ref`, which is an implicit allOf.
      // 3.0 says siblings are ignored; honouring that difference is a real semantic
      // distinction, not a formatting one.
      const siblings = meaningfulSiblings(schema);
      if (siblings.length > 0 && this.specVersion === "3.1") {
        const siblingSchema: Record<string, unknown> = {};
        for (const key of siblings) siblingSchema[key] = schema[key];
        const siblingId = this.registerNode(
          pointer(fallbackPointer, "$refSiblings"),
          { kind: "inline", pointer: fallbackPointer },
          siblingSchema,
          depth + 1
        );
        return this.registerNode(
          fallbackPointer,
          { kind: "inline", pointer: fallbackPointer },
          { allOf: [] },
          depth,
          { allOf: [targetId, siblingId] }
        );
      }
      return targetId;
    }

    return this.registerNode(fallbackPointer, originFor(fallbackPointer), schema, depth);
  }

  private registerFromPointer(canonicalPointer: string, target: Record<string, unknown>, depth: number): SchemaId {
    if (this.nodes.has(canonicalPointer) || this.inProgress.has(canonicalPointer)) return canonicalPointer;
    return this.registerNode(canonicalPointer, originFor(canonicalPointer), target, depth);
  }

  private registerExternal(id: SchemaId, ref: string): SchemaId {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, emptyNode(id, { kind: "external", ref }, ["external-ref"]));
    }
    return id;
  }

  private registerNode(
    id: SchemaId,
    origin: SchemaOrigin,
    schema: Record<string, unknown>,
    depth: number,
    overrides: Partial<SchemaNode> = {}
  ): SchemaId {
    if (this.nodes.has(id) || this.inProgress.has(id)) return id;
    this.nodeBudget.spend();
    assertDepth(depth, this.limits);

    // Registering the id *before* descending is what makes recursive schemas safe:
    // a child that refers back finds the id already in flight and stops.
    this.inProgress.add(id);
    try {
      const node = this.buildNode(id, origin, schema, depth);
      this.nodes.set(id, { ...node, ...overrides });
    } finally {
      this.inProgress.delete(id);
    }
    return id;
  }

  private buildNode(
    id: SchemaId,
    origin: SchemaOrigin,
    schema: Record<string, unknown>,
    depth: number
  ): SchemaNode {
    const unsupported: UnsupportedKeyword[] = [];
    const unsupportedValues: Record<string, unknown> = {};
    for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
      if (schema[keyword] !== undefined) {
        unsupported.push(keyword);
        unsupportedValues[keyword] = schema[keyword];
        this.unsupported.push({
          pointer: id,
          feature: keyword,
          detail: `Tern does not analyse the "${keyword}" keyword; compatibility for this schema is reported as UNKNOWN.`
        });
      }
    }

    const { types, nullable } = normalizeTypes(schema, this.specVersion);

    const properties = new Map<string, SchemaId>();
    const rawProperties = record(schema.properties);
    if (rawProperties) {
      for (const name of Object.keys(rawProperties).sort()) {
        properties.set(
          name,
          this.resolveSchema(rawProperties[name], pointer(id, "properties", name), depth + 1)
        );
      }
    }

    const required = new Set(stringArray(schema.required).sort());

    let additionalProperties: boolean | SchemaId | undefined;
    if (schema.additionalProperties === true || schema.additionalProperties === false) {
      additionalProperties = schema.additionalProperties;
    } else if (record(schema.additionalProperties)) {
      additionalProperties = this.resolveSchema(
        schema.additionalProperties,
        pointer(id, "additionalProperties"),
        depth + 1
      );
    }

    const items =
      schema.items !== undefined ? this.resolveSchema(schema.items, pointer(id, "items"), depth + 1) : undefined;

    const composition = (keyword: "oneOf" | "anyOf" | "allOf"): SchemaId[] | undefined => {
      const list = schema[keyword];
      if (!Array.isArray(list)) return undefined;
      return list.map((member, index) =>
        this.resolveSchema(member, pointer(id, keyword, index), depth + 1)
      );
    };

    const enumValues = Array.isArray(schema.enum) ? sortCanonically(schema.enum) : undefined;
    if (enumValues && enumValues.length > this.limits.maxEnumValues) {
      throw new OpenAPIError(`Enum exceeds ${this.limits.maxEnumValues} values`, {
        code: "OPENAPI_ENUM_TOO_LARGE",
        details: { pointer: id, count: enumValues.length }
      });
    }

    return {
      id,
      origin,
      types,
      nullable,
      format: typeof schema.format === "string" ? schema.format : undefined,
      enum: enumValues,
      const: schema.const !== undefined ? { value: schema.const } : undefined,
      properties,
      required,
      additionalProperties,
      items,
      oneOf: composition("oneOf"),
      anyOf: composition("anyOf"),
      allOf: composition("allOf"),
      numeric: normalizeNumeric(schema, this.specVersion),
      string: normalizeString(schema),
      array: normalizeArray(schema),
      default: schema.default !== undefined ? { value: schema.default } : undefined,
      readOnly: schema.readOnly === true,
      writeOnly: schema.writeOnly === true,
      deprecated: schema.deprecated === true,
      unsupported,
      unsupportedSignature: unsupported.length > 0 ? canonicalJson(unsupportedValues) : undefined
    };
  }

  /** Resolve a `$ref` on a non-schema object (path item, parameter, response, …). */
  private dereference(value: unknown, atPointer: string): Record<string, unknown> | undefined {
    const node = record(value);
    if (!node) return undefined;
    const ref = node.$ref;
    if (typeof ref !== "string") return node;

    const classified = classifyRef(ref);
    if (classified.kind === "external") {
      this.unsupported.push({
        pointer: atPointer,
        feature: "external-$ref",
        detail: `Tern does not resolve external references (${classified.reason}); this element is skipped.`
      });
      return undefined;
    }
    const resolved = followRef(this.raw, ref, this.limits.maxRefChain);
    return resolved?.target;
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise the type keyword.
 *
 * `type: "string"` + `nullable: true` (3.0) and `type: ["string", "null"]` (3.1) are
 * the same statement and must produce the same model, otherwise a document migrated
 * from 3.0 to 3.1 would look like a wall of breaking changes.
 */
export function normalizeTypes(
  schema: Record<string, unknown>,
  specVersion: "3.0" | "3.1"
): { types: string[]; nullable: boolean } {
  const raw = schema.type;
  const collected: string[] = [];
  if (typeof raw === "string") collected.push(raw);
  else if (Array.isArray(raw)) {
    for (const entry of raw) if (typeof entry === "string") collected.push(entry);
  }

  let nullable = collected.includes("null");
  const types = [...new Set(collected.filter((t) => t !== "null"))].sort();

  // `nullable` is a 3.0 keyword. In 3.1 it has no meaning and is ignored, exactly as
  // a conforming 3.1 tool would.
  if (specVersion === "3.0" && schema.nullable === true) nullable = true;

  return { types, nullable };
}

function normalizeNumeric(schema: Record<string, unknown>, specVersion: "3.0" | "3.1"): NumericConstraints {
  const minimum = numberOrUndefined(schema.minimum);
  const maximum = numberOrUndefined(schema.maximum);
  const result: NumericConstraints = {};

  if (specVersion === "3.0") {
    // 3.0: exclusiveMinimum/Maximum are booleans modifying minimum/maximum.
    if (schema.exclusiveMinimum === true && minimum !== undefined) result.exclusiveMinimum = minimum;
    else if (minimum !== undefined) result.minimum = minimum;
    if (schema.exclusiveMaximum === true && maximum !== undefined) result.exclusiveMaximum = maximum;
    else if (maximum !== undefined) result.maximum = maximum;
  } else {
    if (minimum !== undefined) result.minimum = minimum;
    if (maximum !== undefined) result.maximum = maximum;
    const exclusiveMin = numberOrUndefined(schema.exclusiveMinimum);
    const exclusiveMax = numberOrUndefined(schema.exclusiveMaximum);
    if (exclusiveMin !== undefined) result.exclusiveMinimum = exclusiveMin;
    if (exclusiveMax !== undefined) result.exclusiveMaximum = exclusiveMax;
  }

  const multipleOf = numberOrUndefined(schema.multipleOf);
  if (multipleOf !== undefined) result.multipleOf = multipleOf;
  return result;
}

function normalizeString(schema: Record<string, unknown>): StringConstraints {
  const result: StringConstraints = {};
  const minLength = numberOrUndefined(schema.minLength);
  const maxLength = numberOrUndefined(schema.maxLength);
  if (minLength !== undefined) result.minLength = minLength;
  if (maxLength !== undefined) result.maxLength = maxLength;
  if (typeof schema.pattern === "string") result.pattern = schema.pattern;
  return result;
}

function normalizeArray(schema: Record<string, unknown>): ArrayConstraints {
  const result: ArrayConstraints = {};
  const minItems = numberOrUndefined(schema.minItems);
  const maxItems = numberOrUndefined(schema.maxItems);
  if (minItems !== undefined) result.minItems = minItems;
  if (maxItems !== undefined) result.maxItems = maxItems;
  if (schema.uniqueItems === true) result.uniqueItems = true;
  return result;
}

/**
 * Canonical ordering for enum values.
 *
 * Enum *membership* is semantic; enum *order* is not. Sorting by the canonical JSON
 * encoding makes `[a, b]` and `[b, a]` identical, so re-ordering an enum produces no
 * change while adding or removing a value always does.
 */
export function sortCanonically(values: readonly unknown[]): unknown[] {
  return [...values].sort((a, b) => {
    const left = canonicalJson(a);
    const right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Stable JSON encoding with object keys sorted, used for comparison and hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  return JSON.stringify(value) ?? "null";
}

function meaningfulSiblings(schema: Record<string, unknown>): string[] {
  return Object.keys(schema).filter((key) => key !== "$ref" && key !== "description" && key !== "summary");
}

function mergeParameters(
  pathLevel: readonly ApiParameter[],
  operationLevel: readonly ApiParameter[],
  opPointer: string
): ApiParameter[] {
  const merged = new Map<string, ApiParameter>();
  for (const parameter of pathLevel) merged.set(`${parameter.in}:${parameter.name}`, parameter);
  // Operation-level parameters override path-level ones with the same name and location.
  for (const parameter of operationLevel) merged.set(`${parameter.in}:${parameter.name}`, parameter);
  void opPointer;
  return [...merged.values()].sort((a, b) =>
    a.in === b.in ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.in < b.in ? -1 : 1
  );
}

/**
 * Status codes sort numerically, with `default` last, so responses are compared in a
 * stable order regardless of how they were written.
 */
function compareStatusCodes(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function originFor(id: string): SchemaOrigin {
  const match = /^#\/components\/schemas\/([^/]+)$/.exec(id);
  if (match) return { kind: "component", name: match[1].replace(/~1/g, "/").replace(/~0/g, "~") };
  return { kind: "inline", pointer: id };
}

function emptyNode(id: SchemaId, origin: SchemaOrigin, unsupported: UnsupportedKeyword[] = []): SchemaNode {
  return {
    id,
    origin,
    types: [],
    nullable: false,
    properties: new Map(),
    required: new Set(),
    additionalProperties: undefined,
    numeric: {},
    string: {},
    array: {},
    readOnly: false,
    writeOnly: false,
    deprecated: false,
    unsupported
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
