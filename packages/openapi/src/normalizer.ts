
import {
  OpenApiDocument, PathItemObject, OperationObject, SchemaObject,
  NormalizedOperation, NormalizedParameter, NormalizedSchema, HttpMethod, HTTP_METHODS
} from "./interfaces";

export function normalizeOperations(spec: OpenApiDocument): NormalizedOperation[] {
  const operations: NormalizedOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = (item as any)[method] as OperationObject | undefined;
      if (!op) continue;
      operations.push({
        path,
        method,
        operationId: op.operationId,
        summary: op.summary,
        parameters: normalizeParameters(item, op),
        requestBody: normalizeRequestBody(op),
        responses: normalizeResponses(op)
      });
    }
  }
  return operations;
}

function normalizeParameters(item: PathItemObject, op: OperationObject): NormalizedParameter[] {
  const seen = new Map<string, NormalizedParameter>();
  for (const source of [item.parameters || [], op.parameters || []]) {
    for (const p of source) {
      const key = `${p.in}:${p.name}`;
      seen.set(key, {
        name: p.name,
        in: p.in,
        required: p.required ?? (p.in === "path"),
        schema: p.schema ? normalizeSchema(p.schema) : undefined
      });
    }
  }
  return Array.from(seen.values());
}

function normalizeRequestBody(op: OperationObject): NormalizedSchema | undefined {
  if (!op.requestBody?.content) return undefined;
  for (const [media, mediaType] of Object.entries(op.requestBody.content)) {
    if (mediaType.schema) return normalizeSchema(mediaType.schema);
  }
  return undefined;
}

function normalizeResponses(op: OperationObject): Record<string, NormalizedSchema> {
  const out: Record<string, NormalizedSchema> = {};
  for (const [code, resp] of Object.entries(op.responses || {})) {
    if (!resp.content) continue;
    for (const mediaType of Object.values(resp.content)) {
      if (mediaType.schema) {
        out[code] = normalizeSchema(mediaType.schema);
        break;
      }
    }
  }
  return out;
}

export function normalizeSchema(schema: SchemaObject, refs: string[] = []): NormalizedSchema {
  if (schema.$ref) {
    return { type: "$ref", refs: [...refs, schema.$ref], description: schema.description };
  }
  const type = schema.type || inferType(schema);
  const normalized: NormalizedSchema = {
    type,
    required: schema.required,
    properties: schema.properties ? Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, normalizeSchema(v, refs)])
    ) : undefined,
    enum: schema.enum,
    items: schema.items ? normalizeSchema(schema.items, refs) : undefined,
    refs: refs.length ? refs : undefined,
    nullable: schema.nullable,
    additionalProperties: schema.additionalProperties === true ? true : (schema.additionalProperties ? normalizeSchema(schema.additionalProperties, refs) : undefined),
    oneOf: schema.oneOf?.map(s => normalizeSchema(s, refs)),
    anyOf: schema.anyOf?.map(s => normalizeSchema(s, refs)),
    allOf: schema.allOf?.map(s => normalizeSchema(s, refs)),
    description: schema.description
  };
  return normalized;
}

function inferType(schema: SchemaObject): string {
  if (schema.properties) return "object";
  if (schema.items) return "array";
  if (schema.enum) return "string";
  if (schema.oneOf || schema.anyOf || schema.allOf) return "oneOf";
  return "unknown";
}

export function resolveSchema(schema: SchemaObject, doc: OpenApiDocument): SchemaObject {
  if (schema.$ref && doc.components?.schemas) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    const resolved = doc.components.schemas[name];
    if (resolved) return resolveSchema(resolved, doc);
  }
  return schema;
}
