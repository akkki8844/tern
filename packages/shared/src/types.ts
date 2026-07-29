
export type AnalysisId = string & { readonly __brand: "AnalysisId" };
export type RepositoryId = string & { readonly __brand: "RepositoryId" };
export type InstallationId = number & { readonly __brand: "InstallationId" };
export type PullRequestId = string & { readonly __brand: "PullRequestId" };

export interface RepositoryRef {
  id: RepositoryId;
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: InstallationId;
  isPrivate: boolean;
  url: string;
}

export interface OpenApiSpec {
  id: string;
  repositoryId: RepositoryId;
  content: string;
  format: "yaml" | "json";
  version: string;
  createdAt: Date;
}

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
  diff: string;
  lineCountChanged: number;
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
  id: PullRequestId;
  number: number;
  title: string;
  body: string;
  url: string;
  branch: string;
  baseBranch: string;
  status: "open" | "closed" | "merged";
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  resource: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

export interface AnalysisJob {
  id: AnalysisId;
  repositoryId: RepositoryId;
  baseCommitSha: string;
  headCommitSha: string;
  oldSpecId: string;
  newSpecId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: Date;
  updatedAt: Date;
}
