/**
 * Detected-usage and report model: the output half of the scanner.
 */
import type { Confidence, Evidence, OperationKey, Range, Severity } from "./types.js";
import type { ExcludedFile, SourceFile } from "./types.js";

/**
 * What kind of API usage was detected. The kind is part of the evidence: it
 * tells the reader *how* the code reaches the operation.
 */
export type UsageKind =
  | "fetch-call"
  | "axios-call"
  | "http-client-call"
  | "generated-client-call"
  | "sdk-client-call"
  | "request-object-call"
  | "wrapper-caller"
  | "typed-property-access";

export interface MethodPathMatch {
  readonly path: string;
  readonly method?: string;
}

/** A usage matched to an OpenAPI operation, with the changes that apply. */
export interface DetectedUsage {
  /** Deterministic: sha256 of coordinates + kind + operation + change ids. */
  readonly id: string;
  /** Repo-relative POSIX path of the file containing the usage. */
  readonly file: string;
  readonly range: Range;
  /** One-based line/column of the call or access (matches editor gutters). */
  readonly line: number;
  readonly column: number;
  readonly kind: UsageKind;
  /** Operation this usage reaches, when identified. */
  readonly operation?: OperationKey;
  /** When several operations could not be distinguished. */
  readonly operationCandidates?: ReadonlyArray<OperationKey>;
  /** Name of the called symbol or accessed root, as written in the source. */
  readonly symbol: string;
  /** Enclosing named function/method, when known. */
  readonly enclosingSymbol?: string;
  /** The OpenAPI change ids (from the Turn 2 analysis) that affect this usage. */
  readonly changeIds: ReadonlyArray<string>;
  /** Rule ids behind those change ids, de-duplicated and sorted. */
  readonly changeRules: ReadonlyArray<string>;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly evidence: ReadonlyArray<Evidence>;
  /** Snippet of the exact source line(s). */
  readonly snippet: string;
  /**
   * Why this usage is related to the changes, as one stable sentence built
   * from evidence, e.g. "calls POST /charges, which changed by rule X".
   */
  readonly explanation: string;
  /** True when the usage was found via a wrapper/import chain, not directly. */
  readonly indirect: boolean;
  /** Import chain from this file to the module performing the direct call. */
  readonly viaChain?: ReadonlyArray<string>;
}

/**
 * The affected usage graph. Nodes are changes, operations, usages, symbols,
 * functions and files; edges connect them. Built for Turn 4 consumption.
 */
export interface UsageGraph {
  readonly changes: ReadonlyArray<{ readonly changeId: string; readonly rule: string; readonly severity: Severity }>;
  readonly operations: ReadonlyArray<{
    readonly key: string;
    readonly path: string;
    readonly method: string;
    readonly operationId?: string;
  }>;
  /** changeId -> operation keys. */
  readonly changeToOperations: ReadonlyArray<{ readonly changeId: string; readonly operationKeys: ReadonlyArray<string> }>;
  /** operationKey -> usage ids. */
  readonly operationToUsages: ReadonlyArray<{ readonly operationKey: string; readonly usageIds: ReadonlyArray<string> }>;
  /** usageId -> enclosing function symbol id (if any) and its file. */
  readonly usageAncestry: ReadonlyArray<{
    readonly usageId: string;
    readonly symbol?: string;
    readonly enclosingFunction?: string;
    readonly file: string;
    readonly importedBy?: ReadonlyArray<string>;
  }>;
}

export interface DiscoveryMetrics {
  readonly filesConsidered: number;
  readonly filesIncluded: number;
  readonly exclusions: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
}

export interface ParseMetrics {
  readonly filesParsedOk: number;
  readonly filesWithParseErrors: number;
  readonly filesRefused: number;
  readonly reportedErrorFiles: ReadonlyArray<string>;
}

export interface ModuleMetrics {
  readonly importsTotal: number;
  readonly importsResolvedInternal: number;
  readonly importsExternal: number;
  readonly importsUnresolved: number;
  readonly tsconfigPathsApplied: boolean;
}

export interface SymbolMetrics {
  readonly declarations: number;
  readonly referencesResolved: number;
  readonly referencesUnresolved: number;
  readonly shadowedBindings: number;
}

export interface UsageMetrics {
  readonly callSitesConsidered: number;
  readonly directUsages: number;
  readonly indirectUsages: number;
  readonly byConfidence: ReadonlyArray<{ readonly confidence: Confidence; readonly count: number }>;
  readonly byKind: ReadonlyArray<{ readonly kind: UsageKind; readonly count: number }>;
}

export interface MatchingMetrics {
  readonly operationsIndexed: number;
  readonly changesConsidered: number;
  readonly operationsMatched: number;
  /** Conditional changes ruled out because usage evidence contradicts them. */
  readonly refinedOut: number;
  readonly ambiguousMatches: number;
}

export interface FlowMetrics {
  readonly responseRootsTracked: number;
  readonly untrackedResponseFlows: number;
  readonly dynamicObjectSpreads: number;
  readonly truncatedWrapperChains: number;
}

/** Deterministic counters. Timings live separately so hashes stay stable. */
export interface ScanMetrics {
  readonly discovery: DiscoveryMetrics;
  readonly parsing: ParseMetrics;
  readonly modules: ModuleMetrics;
  readonly symbols: SymbolMetrics;
  readonly usages: UsageMetrics;
  readonly matching: MatchingMetrics;
  readonly flow: FlowMetrics;
}

export interface RepositoryScan {
  /** Repo-relative POSIX paths of every analysed file, sorted. */
  readonly files: ReadonlyArray<SourceFile>;
  readonly excluded: ReadonlyArray<ExcludedFile>;
  /** Files with parse errors, represented explicitly, never silent. */
  readonly parseFailures: ReadonlyArray<{ readonly file: string; readonly errors: ReadonlyArray<string> }>;
  readonly usages: ReadonlyArray<DetectedUsage>;
  readonly graph: UsageGraph;
  readonly metrics: ScanMetrics;
  readonly timing: ScanTiming;
  /** Which engine produced the scan (`ast` or `literal-fallback`). */
  readonly engine: "ast" | "literal-fallback";
  readonly limits: {
    readonly fileLimitReached: boolean;
    readonly usageLimitReached: boolean;
  };
}

/** Wall-clock timings. Reported for research, excluded from determinism hashes. */
export interface ScanTiming {
  readonly discoveryMs: number;
  readonly parsingMs: number;
  readonly resolutionMs: number;
  readonly detectionMs: number;
  readonly matchingMs: number;
  readonly totalMs: number;
}

