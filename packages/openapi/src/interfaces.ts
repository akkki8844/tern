
import { BreakingChange } from "@tern/shared";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options" | "trace";
export const HTTP_METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string; variables?: Record<string, { default: string; enum?: string[] }> }>;
  paths: Record<string, PathItemObject>;
  components?: ComponentsObject;
  security?: Array<Record<string, string[]>>;
  tags?: Array<{ name: string; description?: string }>;
}

export interface PathItemObject {
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
  trace?: OperationObject;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

export interface ParameterObject {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  deprecated?: boolean;
  schema?: SchemaObject;
  content?: Record<string, MediaTypeObject>;
}

export interface RequestBodyObject {
  required?: boolean;
  description?: string;
  content?: Record<string, MediaTypeObject>;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
  headers?: Record<string, unknown>;
}

export interface MediaTypeObject {
  schema?: SchemaObject;
  examples?: Record<string, unknown>;
  encoding?: Record<string, unknown>;
}

export interface SchemaObject {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaObject>;
  enum?: unknown[];
  items?: SchemaObject;
  $ref?: string;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  nullable?: boolean;
  format?: string;
  default?: unknown;
  readOnly?: boolean;
  writeOnly?: boolean;
  description?: string;
  additionalProperties?: boolean | SchemaObject;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
}

export interface ComponentsObject {
  schemas?: Record<string, SchemaObject>;
  responses?: Record<string, ResponseObject>;
  parameters?: Record<string, ParameterObject>;
  requestBodies?: Record<string, RequestBodyObject>;
  securitySchemes?: Record<string, unknown>;
}

export interface SpecLoader {
  load(source: string): Promise<OpenApiDocument>;
}

export interface DiffEngine {
  diff(oldSpec: OpenApiDocument, newSpec: OpenApiDocument): Promise<BreakingChange[]>;
}

export interface ValidationIssue {
  type: "error" | "warning";
  message: string;
  path: string;
}

export interface SpecValidator {
  validate(spec: OpenApiDocument): Promise<ValidationIssue[]>;
}

export interface NormalizedOperation {
  path: string;
  method: HttpMethod;
  operationId?: string;
  summary?: string;
  parameters: NormalizedParameter[];
  requestBody?: NormalizedSchema;
  responses: Record<string, NormalizedSchema>;
}

export interface NormalizedParameter {
  name: string;
  in: string;
  required: boolean;
  schema?: NormalizedSchema;
}

export interface NormalizedSchema {
  type: string;
  required?: string[];
  properties?: Record<string, NormalizedSchema>;
  enum?: unknown[];
  items?: NormalizedSchema;
  refs?: string[];
  nullable?: boolean;
  additionalProperties?: boolean | NormalizedSchema;
  oneOf?: NormalizedSchema[];
  anyOf?: NormalizedSchema[];
  allOf?: NormalizedSchema[];
  description?: string;
}

export interface MigrationInstruction {
  changeType: string;
  path: string;
  method?: HttpMethod;
  operationId?: string;
  severity: "breaking" | "risky";
  description: string;
  action: string;
  mappings: Array<{ old: string; new: string; kind: string }>;
  confidence: number;
  reasoning: string;
}
