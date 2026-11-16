import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import {
  GitHubError,
  ConfigurationError,
  assertGitHubSlug,
  assertSafeBranchName,
  getLogger,
  internalMessageOf,
  normalizeRelativePath,
  type CreatePullRequestRequest,
  type GitHubAppConfig,
  type GitHubCommitInfo,
  type GitHubFileChange,
  type GitHubProvider,
  type GitHubPullRequestInfo,
  type GitHubRepositoryInfo
} from "@capibara/shared";
import { verifyWebhookSignature } from "./webhook.js";

const logger = getLogger("github-app");

/** Installation clients are reused, but never longer than a token can live. */
const CLIENT_TTL_MS = 30 * 60 * 1000;

interface CachedClient {
  octokit: Octokit;
  expiresAt: number;
}

/**
 * GitHub App backed provider.
 *
 * Authentication model
 *  - the App's private key signs a short-lived JWT (handled by @octokit/auth-app)
 *  - every repository operation uses an *installation* token minted from that JWT
 *  - user OAuth tokens are never used here; they are a different security context
 *  - tokens are never logged, never persisted and never returned to callers except
 *    through `mintInstallationToken`, which exists for repository checkout only
 *
 * Capibara never merges: this class deliberately exposes no merge or approve operation.
 */
export class GitHubAppProvider implements GitHubProvider {
  readonly name = "github-app";
  readonly isReal = true;

  private readonly clients = new Map<number, CachedClient>();
  private appOctokit?: Octokit;

  constructor(private readonly config: GitHubAppConfig) {
    if (!config.enabled) {
      throw new ConfigurationError("GitHubAppProvider requires a fully configured GitHub App", {
        code: "GITHUB_APP_NOT_CONFIGURED"
      });
    }
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
    return verifyWebhookSignature(rawBody, signatureHeader, this.config.webhookSecret);
  }

  /**
   * Mint a scoped installation token. The value is returned to the caller for a
   * single immediate use (git checkout) and must never be stored or logged.
   */
  async mintInstallationToken(installationId: number): Promise<string> {
    return this.call("mintInstallationToken", { installationId }, async () => {
      const app = this.getAppClient();
      const { data } = await app.request("POST /app/installations/{installation_id}/access_tokens", {
        installation_id: installationId
      });
      return data.token;
    });
  }

  async getRepository(installationId: number, owner: string, repo: string): Promise<GitHubRepositoryInfo> {
    assertGitHubSlug(owner, "owner");
    assertGitHubSlug(repo, "repo");
    return this.call("getRepository", { installationId, owner, repo }, async () => {
      const octokit = await this.clientFor(installationId);
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return toRepositoryInfo(data);
    });
  }

  async listInstallationRepositories(installationId: number): Promise<GitHubRepositoryInfo[]> {
    return this.call("listInstallationRepositories", { installationId }, async () => {
      const octokit = await this.clientFor(installationId);
      const repositories: GitHubRepositoryInfo[] = [];
      const iterator = octokit.paginate.iterator(octokit.rest.apps.listReposAccessibleToInstallation, {
        per_page: 100
      });
      for await (const page of iterator) {
        for (const repo of page.data as unknown[]) {
          repositories.push(toRepositoryInfo(repo as RawRepository));
        }
      }
      return repositories;
    });
  }

  async getBranchHead(installationId: number, owner: string, repo: string, branch: string): Promise<GitHubCommitInfo> {
    assertGitHubSlug(owner, "owner");
    assertGitHubSlug(repo, "repo");
    assertSafeBranchName(branch);
    return this.call("getBranchHead", { installationId, owner, repo, branch }, async () => {
      const octokit = await this.clientFor(installationId);
      const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
      return {
        sha: data.commit.sha,
        message: data.commit.commit.message,
        authorName: data.commit.commit.author?.name ?? "unknown",
        authorEmail: data.commit.commit.author?.email ?? "",
        committedAt: data.commit.commit.author?.date ?? new Date().toISOString(),
        url: data.commit.html_url ?? ""
      };
    });
  }

  async getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null> {
    assertGitHubSlug(owner, "owner");
    assertGitHubSlug(repo, "repo");
    const safePath = normalizeRelativePath(path);
    return this.call("getFileContent", { installationId, owner, repo, path: safePath, ref }, async () => {
      const octokit = await this.clientFor(installationId);
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path: safePath, ref });
        if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") return null;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (error) {
        if (isStatus(error, 404)) return null;
        throw error;
      }
    });
  }

  async createBranch(
    installationId: number,
    owner: string,
    repo: string,
    branch: string,
    fromSha: string
  ): Promise<void> {
    assertGitHubSlug(owner, "owner");
    assertGitHubSlug(repo, "repo");
    assertSafeBranchName(branch);
    assertCommitSha(fromSha);
    await this.call("createBranch", { installationId, owner, repo, branch }, async () => {
      const octokit = await this.clientFor(installationId);
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: fromSha });
    });
  }

  async commitFiles(
    installationId: number,
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: GitHubFileChange[]
  ): Promise<GitHubCommitInfo> {
    assertGitHubSlug(owner, "owner");
    assertGitHubSlug(repo, "repo");
    assertSafeBranchName(branch);
    if (files.length === 0) {
      throw new GitHubError("Refusing to create an empty commit", { code: "GITHUB_EMPTY_COMMIT" });
    }
    const safeFiles = files.map((file) => ({ path: normalizeRelativePath(file.path), content: file.content }));

    return this.call("commitFiles", { installationId, owner, repo, branch, fileCount: files.length }, async () => {
      const octokit = await this.clientFor(installationId);
      const { data: head } = await octokit.rest.repos.getBranch({ owner, repo, branch });
      const baseSha = head.commit.sha;

      const tree = [];
      for (const file of safeFiles) {
        const { data: blob } = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: Buffer.from(file.content, "utf8").toString("base64"),
          encoding: "base64"
        });
        tree.push({ path: file.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha });
      }

      const { data: newTree } = await octokit.rest.git.createTree({ owner, repo, base_tree: baseSha, tree });
      const { data: commit } = await octokit.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: newTree.sha,
        parents: [baseSha]
      });
      await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha });

      return {
        sha: commit.sha,
        message,
        authorName: commit.author?.name ?? "Capibara",
        authorEmail: commit.author?.email ?? "",
        committedAt: commit.author?.date ?? new Date().toISOString(),
        url: commit.html_url
      };
    });
  }

  async createPullRequest(request: CreatePullRequestRequest): Promise<GitHubPullRequestInfo> {
    assertGitHubSlug(request.owner, "owner");
    assertGitHubSlug(request.repo, "repo");
    assertSafeBranchName(request.head);
    assertSafeBranchName(request.base);
    return this.call(
      "createPullRequest",
      { installationId: request.installationId, owner: request.owner, repo: request.repo, head: request.head },
      async () => {
        const octokit = await this.clientFor(request.installationId);
        const { data } = await octokit.rest.pulls.create({
          owner: request.owner,
          repo: request.repo,
          title: request.title,
          body: request.body,
          head: request.head,
          base: request.base,
          // Human review is mandatory. Capibara opens drafts by default and never merges.
          draft: request.draft ?? true,
          maintainer_can_modify: true
        });
        return {
          id: String(data.id),
          number: data.number,
          title: data.title,
          url: data.html_url,
          branch: request.head,
          baseBranch: request.base,
          status: data.state === "closed" ? "closed" : "open",
          draft: Boolean(data.draft)
        };
      }
    );
  }

  async downloadTarball(
    installationId: number,
    owner: string,
    repo: string,
    ref: string
  ): Promise<ReadableStream<Uint8Array>> {
    assertGitHubSlug(owner, "owner");
    assertGitHubSlug(repo, "repo");
    return this.call("downloadTarball", { installationId, owner, repo, ref }, async () => {
      const octokit = await this.clientFor(installationId);
      const response = await octokit.rest.repos.downloadTarballArchive({ owner, repo, ref });
      const data = response.data as unknown;
      if (data instanceof ArrayBuffer) {
        return new Blob([new Uint8Array(data)]).stream();
      }
      throw new GitHubError("Unexpected tarball response type", { code: "GITHUB_TARBALL_UNEXPECTED" });
    });
  }

  // -------------------------------------------------------------------------

  private getAppClient(): Octokit {
    if (!this.appOctokit) {
      this.appOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId: this.config.appId, privateKey: this.config.privateKey.reveal() },
        baseUrl: this.config.apiBaseUrl
      });
    }
    return this.appOctokit;
  }

  private async clientFor(installationId: number): Promise<Octokit> {
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new GitHubError("Invalid installation id", { code: "GITHUB_INSTALLATION_INVALID" });
    }
    const cached = this.clients.get(installationId);
    if (cached && cached.expiresAt > Date.now()) return cached.octokit;

    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.config.appId, privateKey: this.config.privateKey.reveal(), installationId },
      baseUrl: this.config.apiBaseUrl
    });
    this.clients.set(installationId, { octokit, expiresAt: Date.now() + CLIENT_TTL_MS });
    return octokit;
  }

  /** Uniform error translation, logging and rate-limit classification. */
  private async call<T>(operation: string, context: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      logger.debug("github call succeeded", { operation, ...context, durationMs: Date.now() - start });
      return result;
    } catch (error) {
      const status = statusOf(error);
      const retryable = status === undefined || status === 429 || status >= 500 || isRateLimited(error);
      logger.warn("github call failed", {
        operation,
        ...context,
        status,
        retryable,
        durationMs: Date.now() - start,
        reason: internalMessageOf(error)
      });
      throw new GitHubError(`GitHub ${operation} failed`, {
        code: status ? `GITHUB_HTTP_${status}` : "GITHUB_REQUEST_FAILED",
        retryable,
        cause: error,
        details: { operation, status, ...context },
        publicMessage:
          status === 403 || status === 401
            ? "Capibara is not authorised to perform this GitHub operation."
            : "A GitHub operation failed. Please retry."
      });
    }
  }
}

interface RawRepository {
  id: number;
  name: string;
  private?: boolean;
  default_branch?: string;
  html_url?: string;
  owner?: { login?: string };
}

function toRepositoryInfo(raw: RawRepository): GitHubRepositoryInfo {
  return {
    githubId: raw.id,
    owner: raw.owner?.login ?? "",
    name: raw.name,
    defaultBranch: raw.default_branch ?? "main",
    isPrivate: Boolean(raw.private),
    url: raw.html_url ?? ""
  };
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function isStatus(error: unknown, status: number): boolean {
  return statusOf(error) === status;
}

function isRateLimited(error: unknown): boolean {
  const headers = (error as { response?: { headers?: Record<string, string> } })?.response?.headers;
  return headers?.["x-ratelimit-remaining"] === "0" || headers?.["retry-after"] !== undefined;
}

function assertCommitSha(sha: string): void {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new GitHubError("Invalid commit sha", { code: "GITHUB_SHA_INVALID" });
  }
}
