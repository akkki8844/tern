/**
 * Legacy compatibility layer.
 *
 * The pipeline, migration engine and older tests consume the flat
 * `AffectedUsage` shape and the `CodeScanner` interface. This module projects
 * the rich semantic scan onto those surfaces without weakening them:
 *
 * - legacy ids are deterministic (derived from the semantic usage id);
 * - confidence collapses `UNKNOWN` to `"low"` — the legacy type has no UNKNOWN;
 * - one legacy usage is emitted per (semantic usage × change) so downstream
 *   consumers see every applicable change;
 * - `TreeSitterScanner` now runs the full AST engine; `SimpleRegexScanner`
 *   became an honest *literal* fallback: string-literal path evidence only,
 *   no description-word guessing (that false-positive machine is gone).
 */
import path from "node:path";
import type { AffectedUsage, BreakingChange } from "@tern/shared";
import type { SpecChangeAnalysis, ApiChange } from "@tern/openapi";
import type { RepositoryScan, DetectedUsage } from "../model/usage.js";
import type { CodeScanner, ScanBenchmark, ScanOptions } from "../interfaces.js";
import type { RuleId } from "@tern/openapi";

// ---------------------------------------------------------------------------
// Semantic → legacy projection
// ---------------------------------------------------------------------------


export function projectToLegacyUsages(
  scan: RepositoryScan,
  repoRoot: string
): AffectedUsage[] {
  const out: AffectedUsage[] = [];
  for (const usage of scan.usages) {
    const context = contextAround(scan, usage);
    const changeIds = usage.changeIds.length > 0 ? usage.changeIds : [""];
    for (const changeId of changeIds) {
      out.push({
        id: `${usage.id}#${changeId}`,
        file: toPosix(path.relative(repoRoot, path.join(repoRoot, usage.file))) || usage.file,
        line: usage.line,
        column: usage.column,
        functionName: usage.enclosingSymbol ?? usage.symbol,
        importPath: usage.viaChain?.[0],
        snippet: usage.snippet,
        contextBefore: context.before,
        contextAfter: context.after,
        confidence: legacyConfidence(usage.confidence),
        breakingChangeId: changeId,
        operationId: usage.operation?.operationId,
        httpMethod: usage.operation?.method ?? undefined,
        pathPattern: usage.operation?.path
      });
    }
  }
  out.sort(compareLegacy);
  return out;
}

function compareLegacy(a: AffectedUsage, b: AffectedUsage): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.column !== b.column) return a.column - b.column;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function legacyConfidence(confidence: DetectedUsage["confidence"]): "high" | "medium" | "low" {
  switch (confidence) {
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    default:
      return "low";
  }
}

function contextAround(
  scan: RepositoryScan,
  usage: DetectedUsage
): { before: string; after: string } {
  void scan;
  void usage;
  // Snippet context is intentionally omitted in the projection: the semantic
  // usage carries the full evidence, and duplicating raw file context here
  // would re-introduce whole-file reads into the migration stage.
  return { before: "", after: "" };
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Legacy changes → minimal semantic input (for the CodeScanner interface)
// ---------------------------------------------------------------------------

const LEGACY_TYPE_TO_RULE: Record<BreakingChange["type"], RuleId> = {
  "endpoint-removed": "PATH_REMOVED",
  "method-changed": "OPERATION_REMOVED",
  "operation-id-removed": "OPERATION_ID_REMOVED",
  "path-parameter-renamed": "PARAMETER_REMOVED",
  "required-parameter-added": "REQUIRED_PARAMETER_ADDED",
  "required-parameter-removed": "PARAMETER_REMOVED",
  "request-field-renamed": "PROPERTY_REMOVED",
  "request-field-removed": "PROPERTY_REMOVED",
  "response-field-renamed": "PROPERTY_REMOVED",
  "response-field-removed": "PROPERTY_REMOVED",
  "enum-value-added": "ENUM_VALUE_ADDED",
  "enum-value-removed": "ENUM_VALUE_REMOVED",
  "type-changed": "TYPE_CHANGED",
  "sdk-method-renamed": "OPERATION_ID_REMOVED",
  "sdk-import-renamed": "OPERATION_ID_REMOVED",
  general: "OPERATION_REMOVED"
};

const LEGACY_TYPE_DIRECTION: Record<BreakingChange["type"], "request" | "response" | "both"> = {
  "endpoint-removed": "both",
  "method-changed": "both",
  "operation-id-removed": "both",
  "path-parameter-renamed": "request",
  "required-parameter-added": "request",
  "required-parameter-removed": "request",
  "request-field-renamed": "request",
  "request-field-removed": "request",
  "response-field-renamed": "response",
  "response-field-removed": "response",
  "enum-value-added": "both",
  "enum-value-removed": "both",
  "type-changed": "both",
  "sdk-method-renamed": "both",
  "sdk-import-renamed": "both",
  general: "both"
};

/**
 * Build a minimal `SpecChangeAnalysis` from legacy breaking changes so the
 * `CodeScanner` interface keeps working for callers that only have legacy
 * changes. The full pipeline always passes the real Turn 2 analysis.
 */
export function legacyChangesToAnalysis(changes: ReadonlyArray<BreakingChange>): SpecChangeAnalysis {
  const apiChanges: ApiChange[] = changes.map((change) => ({
    id: change.id,
    rule: LEGACY_TYPE_TO_RULE[change.type],
    kind: "operation",
    location: {
      displayPath: change.path,
      path: change.path,
      ...(change.method !== undefined ? { method: change.method as ApiChange["location"]["method"] } : {}),
      ...(change.operationId !== undefined ? { operationId: change.operationId } : {})
    },
    direction: LEGACY_TYPE_DIRECTION[change.type],
    severity: change.severity === "breaking" ? "BREAKING" : "CONDITIONAL",
    breaking: change.severity === "breaking",
    confidence: "HIGH",
    reason: change.description,
    ...(change.oldValue !== undefined ? { oldValue: change.oldValue } : {}),
    ...(change.newValue !== undefined ? { newValue: change.newValue } : {})
  }));
  return {
    oldVersion: "",
    newVersion: "",
    oldOpenApiVersion: "",
    newOpenApiVersion: "",
    changes: apiChanges,
    renameCandidates: [],
    unsupported: [],
    summary: {
      total: apiChanges.length,
      breaking: apiChanges.filter((c) => c.severity === "BREAKING").length,
      conditional: apiChanges.filter((c) => c.severity === "CONDITIONAL").length,
      nonBreaking: 0,
      unknown: 0
    },
    componentUsage: []
  } as unknown as SpecChangeAnalysis;
}

// ---------------------------------------------------------------------------
// Scanner implementations behind the legacy CodeScanner interface
// ---------------------------------------------------------------------------

export function emptyBenchmark(): ScanBenchmark {
  return { filesScanned: 0, totalLines: 0, callSitesFound: 0, matchesFound: 0, durationMs: 0 };
}

export function benchmarkFromScan(scan: RepositoryScan): ScanBenchmark {
  return {
    filesScanned: scan.metrics.discovery.filesIncluded,
    totalLines: scan.metrics.symbols.declarations,
    callSitesFound: scan.metrics.usages.callSitesConsidered,
    matchesFound: scan.usages.length,
    durationMs: scan.timing.totalMs
  };
}

export interface LegacyScanTarget extends CodeScanner {}

export function scanOptionsFrom(options?: ScanOptions): {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxFileSizeBytes?: number;
} {
  if (options === undefined) return {};
  return {
    ...(options.include !== undefined ? { include: options.include } : {}),
    ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxFileSizeBytes !== undefined ? { maxFileSizeBytes: options.maxFileSizeBytes } : {})
  };
}

// ---------------------------------------------------------------------------
// Empty scan construction (no-change runs and degraded fallback engines)
// ---------------------------------------------------------------------------

/** A valid, empty scan result for runs that could not analyse anything. */
export function emptyScan(engine: "ast" | "literal-fallback", reason?: string): RepositoryScan {
  void reason;
  return {
    files: [],
    excluded: [],
    parseFailures: [],
    usages: [],
    graph: { changes: [], operations: [], changeToOperations: [], operationToUsages: [], usageAncestry: [] },
    engine,
    limits: { fileLimitReached: false, usageLimitReached: false },
    timing: { discoveryMs: 0, parsingMs: 0, resolutionMs: 0, detectionMs: 0, matchingMs: 0, totalMs: 0 },
    metrics: {
      discovery: { filesConsidered: 0, filesIncluded: 0, exclusions: [] },
      parsing: { filesParsedOk: 0, filesWithParseErrors: 0, filesRefused: 0, reportedErrorFiles: [] },
      modules: { importsTotal: 0, importsResolvedInternal: 0, importsExternal: 0, importsUnresolved: 0, tsconfigPathsApplied: false },
      symbols: { declarations: 0, referencesResolved: 0, referencesUnresolved: 0, shadowedBindings: 0 },
      usages: { callSitesConsidered: 0, directUsages: 0, indirectUsages: 0, byConfidence: [], byKind: [] },
      matching: { operationsIndexed: 0, changesConsidered: 0, operationsMatched: 0, refinedOut: 0, ambiguousMatches: 0 },
      flow: { responseRootsTracked: 0, untrackedResponseFlows: 0, dynamicObjectSpreads: 0, truncatedWrapperChains: 0 }
    },
  };
}
