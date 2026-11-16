import { OpenAPIError } from "@capibara/shared";

/**
 * Resource limits for OpenAPI analysis.
 *
 * OpenAPI documents are untrusted input. A document can be pathological by accident
 * (a generated spec with 5000 paths) or on purpose (a recursive schema designed to
 * exhaust memory). Every traversal in this package is bounded by these limits and
 * fails with an explicit, typed error rather than hanging or crashing the worker.
 */
export interface AnalysisLimits {
  /** Maximum raw document size in bytes. */
  maxDocumentBytes: number;
  /** Maximum number of nodes visited while building the canonical model. */
  maxModelNodes: number;
  /** Maximum nesting depth of any schema. */
  maxSchemaDepth: number;
  /** Maximum number of operations. */
  maxOperations: number;
  /** Maximum number of component schemas. */
  maxComponentSchemas: number;
  /** Maximum number of enum values considered per schema. */
  maxEnumValues: number;
  /** Maximum number of schema-pair comparisons performed by one diff. */
  maxComparisons: number;
  /** Maximum number of changes emitted by one diff. */
  maxChanges: number;
  /** Maximum length of a `$ref` chain before it is treated as malformed. */
  maxRefChain: number;
}

export const DEFAULT_LIMITS: AnalysisLimits = {
  maxDocumentBytes: 10 * 1024 * 1024,
  maxModelNodes: 200_000,
  maxSchemaDepth: 100,
  maxOperations: 10_000,
  maxComponentSchemas: 20_000,
  maxEnumValues: 10_000,
  maxComparisons: 500_000,
  maxChanges: 50_000,
  maxRefChain: 32
};

/**
 * A counter that fails loudly when a budget is exhausted.
 *
 * Using an explicit budget rather than a recursion depth check alone means a document
 * that is wide (a million sibling properties) is caught as well as one that is deep.
 */
export class Budget {
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly name: string,
    private readonly code: string
  ) {}

  spend(amount = 1): void {
    this.used += amount;
    if (this.used > this.limit) {
      throw new OpenAPIError(`OpenAPI analysis exceeded the ${this.name} limit of ${this.limit}`, {
        code: this.code,
        details: { limit: this.limit, name: this.name },
        publicMessage: "The OpenAPI document is too large or too complex for Capibara to analyse safely."
      });
    }
  }

  get spent(): number {
    return this.used;
  }
}

export function assertDepth(depth: number, limits: AnalysisLimits): void {
  if (depth > limits.maxSchemaDepth) {
    throw new OpenAPIError(`Schema nesting exceeded the maximum depth of ${limits.maxSchemaDepth}`, {
      code: "OPENAPI_SCHEMA_TOO_DEEP",
      details: { maxSchemaDepth: limits.maxSchemaDepth },
      publicMessage: "The OpenAPI document nests schemas too deeply for Capibara to analyse safely."
    });
  }
}
