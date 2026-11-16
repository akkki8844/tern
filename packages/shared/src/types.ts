/**
 * Domain types shared across every Capibara package.
 *
 * These are transport/persistence agnostic: the database maps onto them, the
 * pipeline passes them between stages, and providers return them.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type AnalysisRunId = Brand<string, "AnalysisRunId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type InstallationId = Brand<number, "InstallationId">;
export type JobId = Brand<string, "JobId">;

export function asAnalysisRunId(value: string): AnalysisRunId {
  return value as AnalysisRunId;
}
export function asRepositoryId(value: string): RepositoryId {
  return value as RepositoryId;
}
export function asInstallationId(value: number): InstallationId {
  return value as InstallationId;
}
export function asJobId(value: string): JobId {
  return value as JobId;
}

export interface RepositoryRef {
  id: RepositoryId;
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: InstallationId;
  isPrivate: boolean;
  url: string;
}

export const PIPELINE_STAGES = [
  "DISCOVER",
  "DIFF",
  "SCAN",
  "PLAN",
  "MIGRATE",
  "VALIDATE",
  "TEST",
  "PUBLISH"
] as const;

export type PipelineStageName = (typeof PIPELINE_STAGES)[number];

// ---------------------------------------------------------------------------
// OpenAPI / analysis domain
// ---------------------------------------------------------------------------

export interface OpenApiSpecRef {
  id: string;
  repositoryId: RepositoryId;
  path: string;
  commitSha: string;
  content: string;
  format: "yaml" | "json";
  version: string;
  contentHash: string;
}

export type BreakingChangeType =
  | "endpoint-removed"
  | "method-changed"
  | "operation-id-removed"
  | "path-parameter-renamed"
  | "required-parameter-added"
  | "required-parameter-removed"
  | "request-field-renamed"
  | "request-field-removed"
  | "response-field-renamed"
  | "response-field-removed"
  | "enum-value-added"
  | "enum-value-removed"
  | "type-changed"
  | "sdk-method-renamed"
  | "sdk-import-renamed"
  | "general";

export interface BreakingChange {
  id: string;
  type: BreakingChangeType;
  path: string;
  method?: string;
  operationId?: string;
  description: string;
  severity: "breaking" | "risky";
  oldValue?: unknown;
  newValue?: unknown;
  migrationHint?: string;
}

export interface AffectedUsage {
  id: string;
  file: string;
  line: number;
  column: number;
  functionName: string;
  importPath?: string;
  snippet: string;
  contextBefore: string;
  contextAfter: string;
  confidence: "high" | "medium" | "low";
  breakingChangeId: string;
  operationId?: string;
  httpMethod?: string;
  pathPattern?: string;
}

export interface MigrationPatch {
  id: string;
  filePath: string;
  original: string;
  modified: string;
  description: string;
  breakingChangeId: string;
  validationStatus: "pending" | "valid" | "invalid";
  validationErrors: string[];
  validationWarnings?: string[];
  diff: string;
  lineCountChanged: number;
  confidence?: number;
  appliedRules?: string[];
}

export interface SandboxResult {
  status: "passed" | "failed" | "timed-out" | "errored";
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  testSummary?: string;
  logs: string[];
}

export interface PullRequestDetails {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  branch: string;
  baseBranch: string;
  status: "open" | "closed" | "merged";
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface HealthCheckResult {
  name: string;
  status: "healthy" | "degraded" | "unhealthy";
  latencyMs: number;
  message?: string;
}

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  checks: HealthCheckResult[];
}
