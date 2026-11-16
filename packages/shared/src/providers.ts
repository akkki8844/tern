/**
 * Provider interfaces.
 *
 * The pipeline depends on these abstractions only. Vendor specific code
 * (Octokit, Fireworks, git, the filesystem) lives behind an implementation:
 *
 *   GitHubProvider     <- GitHubAppProvider   | DemoGitHubProvider
 *   AIProvider         <- FireworksAIProvider | DemoAIProvider  | DisabledAIProvider
 *   RepositoryProvider <- GitHubRepositoryProvider | LocalRepositoryProvider
 *   WorkspaceProvider  <- FilesystemWorkspaceProvider
 *
 * Interfaces are deliberately small: only what the pipeline actually calls.
 */
import type { AffectedUsage, BreakingChange } from "./types.js";

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GitHubRepositoryInfo {
  githubId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  url: string;
}

export interface GitHubCommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  url: string;
}

export interface GitHubFileChange {
  /** Repository-relative POSIX path. */
  path: string;
  content: string;
}

export interface CreatePullRequestRequest {
  installationId: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  /** Tern always opens PRs as drafts unless explicitly told otherwise; it never merges. */
  draft?: boolean;
}

export interface GitHubPullRequestInfo {
  id: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  baseBranch: string;
  status: "open" | "closed" | "merged";
  draft: boolean;
}

export interface GitHubProvider {
  /** Human readable implementation name, used in logs and audit records. */
  readonly name: string;
  /** True when the provider performs real, externally visible operations. */
  readonly isReal: boolean;

  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean;
  getRepository(installationId: number, owner: string, repo: string): Promise<GitHubRepositoryInfo>;
  listInstallationRepositories(installationId: number): Promise<GitHubRepositoryInfo[]>;
  getBranchHead(installationId: number, owner: string, repo: string, branch: string): Promise<GitHubCommitInfo>;
  getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null>;
  createBranch(installationId: number, owner: string, repo: string, branch: string, fromSha: string): Promise<void>;
  commitFiles(
    installationId: number,
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: GitHubFileChange[]
  ): Promise<GitHubCommitInfo>;
  createPullRequest(request: CreatePullRequestRequest): Promise<GitHubPullRequestInfo>;
  /** Download a repository tarball for a ref. Returns a readable stream of bytes. */
  downloadTarball(installationId: number, owner: string, repo: string, ref: string): Promise<ReadableStream<Uint8Array>>;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/**
 * The minimum context an AI provider may receive for a single migration.
 * Whole repositories, environment files and credentials are structurally excluded:
 * the provider only ever sees a bounded excerpt of one file plus the change metadata.
 */
export interface AIMigrationRequest {
  breakingChange: Pick<BreakingChange, "type" | "description" | "path" | "method" | "operationId" | "migrationHint">;
  usage: Pick<AffectedUsage, "file" | "line" | "column" | "functionName" | "confidence">;
  /** Bounded excerpt of the file around the usage. Never the whole repository. */
  excerpt: string;
  /** 1-based line number of the first line of `excerpt`. */
  excerptStartLine: number;
  language: "typescript" | "javascript";
}

export interface AIEdit {
  /** Exact text to find in the excerpt. */
  search: string;
  /** Replacement text. */
  replace: string;
  reason: string;
}

export interface AIMigrationResponse {
  edits: AIEdit[];
  /** Provider self-reported confidence, 0..1. Advisory only — never trusted. */
  confidence: number;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface AIProvider {
  readonly name: string;
  readonly isReal: boolean;
  readonly enabled: boolean;
  suggestMigration(request: AIMigrationRequest, signal?: AbortSignal): Promise<AIMigrationResponse>;
}

// ---------------------------------------------------------------------------
// Repository materialisation
// ---------------------------------------------------------------------------

export interface RepositoryCheckout {
  /** Absolute path of the checked out tree. Always inside a workspace. */
  path: string;
  commitSha: string;
}

export interface RepositoryProvider {
  readonly name: string;
  readonly isReal: boolean;
  /**
   * Materialise `ref` of a repository into `destination` (an existing, empty,
   * workspace-owned directory).
   */
  checkout(
    params: { installationId: number; owner: string; repo: string; ref: string },
    destination: string
  ): Promise<RepositoryCheckout>;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly id: string;
  /** Absolute root of this workspace. Nothing may be written outside it. */
  readonly path: string;
  /** Resolve a workspace-relative path, guaranteed to stay inside the workspace. */
  resolve(relativePath: string): string;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  /** Remove the workspace and everything in it. Safe to call more than once. */
  dispose(): Promise<void>;
}

export interface WorkspaceProvider {
  readonly root: string;
  create(ownerKey: string): Promise<Workspace>;
  /** Remove workspaces left behind by crashed processes. Returns the number removed. */
  reapOrphans(olderThanMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Storage (blobs that do not belong in Postgres)
// ---------------------------------------------------------------------------

export interface StorageProvider {
  readonly name: string;
  put(key: string, content: string | Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}
