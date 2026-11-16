import { loadFromString } from "../spec-loader.js";
import type { OpenApiDocument } from "../interfaces.js";
import { analyzeSpecChange, type SpecChangeAnalysis } from "../diff/engine.js";
import type { ApiChange, Severity } from "../diff/changes.js";
import type { RuleId } from "../diff/rules.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SpecInput {
  openapi?: string;
  version?: string;
  paths?: Record<string, any>;
  components?: Record<string, any>;
  servers?: Array<{ url: string }>;
  security?: Array<Record<string, string[]>>;
}

/** Build a valid OpenAPI document from a minimal description. */
export function makeSpec(input: SpecInput = {}): OpenApiDocument {
  return loadFromString(
    JSON.stringify({
      openapi: input.openapi ?? "3.0.3",
      info: { title: "Test API", version: input.version ?? "1.0.0" },
      ...(input.servers ? { servers: input.servers } : {}),
      ...(input.security ? { security: input.security } : {}),
      paths: input.paths ?? {},
      ...(input.components ? { components: input.components } : {})
    })
  );
}

/** `application/json` request body. */
export function jsonBody(schema: any, required = true): any {
  return { required, content: { "application/json": { schema } } };
}

/** `application/json` response for one status code. */
export function jsonResponse(schema: any, statusCode = "200"): any {
  return { [statusCode]: { description: "OK", content: { "application/json": { schema } } } };
}

/** A single-operation document whose request body is the schema under test. */
export function requestSpec(schema: any, options: { required?: boolean } = {}): OpenApiDocument {
  return makeSpec({
    paths: {
      "/things": {
        post: {
          operationId: "createThing",
          requestBody: jsonBody(schema, options.required ?? true),
          responses: { "200": { description: "OK" } }
        }
      }
    }
  });
}

/** A single-operation document whose 200 response is the schema under test. */
export function responseSpec(schema: any): OpenApiDocument {
  return makeSpec({
    paths: {
      "/things": {
        get: { operationId: "listThings", responses: jsonResponse(schema) }
      }
    }
  });
}

export function analyze(oldSpec: OpenApiDocument, newSpec: OpenApiDocument): SpecChangeAnalysis {
  return analyzeSpecChange(oldSpec, newSpec);
}

/** Diff two request-body schemas and return the resulting changes. */
export function diffRequestSchema(oldSchema: any, newSchema: any): readonly ApiChange[] {
  return analyze(requestSpec(oldSchema), requestSpec(newSchema)).changes;
}

/** Diff two response schemas and return the resulting changes. */
export function diffResponseSchema(oldSchema: any, newSchema: any): readonly ApiChange[] {
  return analyze(responseSpec(oldSchema), responseSpec(newSchema)).changes;
}

export function findRule(changes: readonly ApiChange[], rule: RuleId): ApiChange | undefined {
  return changes.find((change) => change.rule === rule);
}

export function rulesOf(changes: readonly ApiChange[]): RuleId[] {
  return changes.map((change) => change.rule);
}

/** Assertion helper: exactly one change with this rule, at this severity. */
export function expectRule(
  changes: readonly ApiChange[],
  rule: RuleId,
  severity: Severity
): ApiChange {
  const matches = changes.filter((change) => change.rule === rule);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${rule}, found ${matches.length}. All rules: ${rulesOf(changes).join(", ")}`
    );
  }
  if (matches[0].severity !== severity) {
    throw new Error(`expected ${rule} to be ${severity}, got ${matches[0].severity}`);
  }
  return matches[0];
}

/** Assertion helper: no change with this rule was produced. */
export function expectNoRule(changes: readonly ApiChange[], rule: RuleId): void {
  const matches = changes.filter((change) => change.rule === rule);
  if (matches.length > 0) {
    throw new Error(`expected no ${rule}, found ${matches.length}`);
  }
}
