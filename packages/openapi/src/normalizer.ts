
import { OpenApiDocument, PathItemObject, OperationObject, SchemaObject, NormalizedOperation, NormalizedParameter, NormalizedSchema, HttpMethod, HTTP_METHODS } from "./interfaces";

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
      seen.set(key, { name: p.name, in: p.in, required: p.required ?? (p.in === "path"), schema: p.schema ? normalizeSchema(p.schema) : undefined });
    }
  }
  return Array.from(seen.values());
}

function normalizeRequestBody(op: OperationObject): NormalizedSchema | undefined {
  if (!op.requestBody?.content) return undefined;
  return firstSchema(op.requestBody.content);
}

function normalizeResponses(op: OperationObject): Record<string, NormalizedSchema> {
  const out: Record<string, NormalizedSchema> = {};
  for (const [code, resp] of Object.entries(op.responses || {})) {
    const schema = firstSchema(resp.content);
    if (schema) out[code] = schema;
  }
  return out;
}

function firstSchema(content: Record<string, { schema?: SchemaObject }> | undefined): NormalizedSchema | undefined {
  if (!content) return undefined;
  for (const mediaType of Object.values(content)) {
    if (mediaType.schema) return normalizeSchema(mediaType.schema);
  }
  return undefined;
}

export function normalizeSchema(schema: SchemaObject, doc?: OpenApiDocument, seen: Set<string> = new Set()): NormalizedSchema {
  if (schema.$ref && doc?.components?.schemas) {
    const name = refToName(schema.$ref);
    if (seen.has(name)) return { type: "$ref", refs: [schema.$ref], description: schema.description };
    const resolved = doc.components.schemas[name];
    if (resolved) return normalizeSchema(resolved, doc, new Set([...seen, name]));
    return { type: "$ref", refs: [schema.$ref], description: schema.description };
  }
  const type = schema.type || inferType(schema);
  return {
    type,
    required: schema.required,
    properties: schema.properties ? Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, normalizeSchema(v, doc, seen)])) : undefined,
    enum: schema.enum,
    items: schema.items ? normalizeSchema(schema.items, doc, seen) : undefined,
    refs: undefined,
    nullable: schema.nullable,
    additionalProperties: schema.additionalProperties === true ? true : (schema.additionalProperties ? normalizeSchema(schema.additionalProperties, doc, seen) : undefined),
    oneOf: schema.oneOf?.map(s => normalizeSchema(s, doc, seen)),
    anyOf: schema.anyOf?.map(s => normalizeSchema(s, doc, seen)),
    allOf: schema.allOf?.map(s => normalizeSchema(s, doc, seen)),
    description: schema.description
  };
}

function inferType(schema: SchemaObject): string {
  if (schema.properties) return "object";
  if (schema.items) return "array";
  if (schema.enum) return "string";
  if (schema.oneOf || schema.anyOf || schema.allOf) return "oneOf";
  return "unknown";
}

function refToName(ref: string): string {
  return ref.replace("#/components/schemas/", "");
}

export function resolveSchema(schema: SchemaObject, doc: OpenApiDocument, seen: Set<string> = new Set()): SchemaObject {
  if (schema.$ref && doc.components?.schemas) {
    const name = refToName(schema.$ref);
    if (seen.has(name)) return schema;
    const resolved = doc.components.schemas[name];
    if (resolved) return resolveSchema(resolved, doc, new Set([...seen, name]));
  }
  return schema;
}
