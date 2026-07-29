
import { BreakingChange } from "@tern/shared";

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItemObject>;
  components?: ComponentsObject;
}

export interface PathItemObject {
  summary?: string;
  description?: string;
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  parameters?: ParameterObject[];
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
}

export interface ParameterObject {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema?: SchemaObject;
}

export interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, MediaTypeObject>;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
}

export interface MediaTypeObject {
  schema?: SchemaObject;
}

export interface SchemaObject {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaObject>;
  enum?: unknown[];
  items?: SchemaObject;
  $ref?: string;
}

export interface ComponentsObject {
  schemas?: Record<string, SchemaObject>;
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
