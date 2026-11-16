import { createHash } from "node:crypto";
import {
  GitHubError,
  getLogger,
  assertGitHubSlug,
  assertSafeBranchName,
  type CreatePullRequestRequest,
  type GitHubCommitInfo,
  type GitHubFileChange,
  type GitHubProvider,
  type GitHubPullRequestInfo,
  type GitHubRepositoryInfo,
  type Secret
} from "@capibara/shared";
import { verifyWebhookSignature } from "./webhook.js";

const logger = getLogger("github-demo");

export const DEMO_INSTALLATION_ID = 1;
export const DEMO_OWNER = "capibara-demo";
export const DEMO_REPO = "acmepay-demo";

interface DemoRepositoryState {
  info: GitHubRepositoryInfo;
  branches: Map<string, string>;
  commits: Map<string, GitHubCommitInfo>;
  files: Map<string, string>;
}

/**
 * In-memory GitHub for demo mode.
 *
 * Nothing here touches the network. Every mutation stays inside this object, so demo
 * mode structurally cannot create a branch, a commit or a pull request on a real
 * repository. `isReal` is false, and the worker refuses to publish with a non-real
 * provider unless demo mode is explicitly enabled.
 */
export class DemoGitHubProvider implements GitHubProvider {
  readonly name = "github-demo";
  readonly isReal = false;

  private readonly repositories = new Map<string, DemoRepositoryState>();
  private readonly pullRequests: GitHubPullRequestInfo[] = [];

  constructor(private readonly webhookSecret?: Secret) {
    this.seed();
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
    if (!this.webhookSecret) return false;
    return verifyWebhookSignature(rawBody, signatureHeader, this.webhookSecret);
  }

  async mintInstallationToken(): Promise<string> {
    // Deliberately not a credential-shaped value.
    return "demo-installation-token-not-a-credential";
  }

  async getRepository(_installationId: number, owner: string, repo: string): Promise<GitHubRepositoryInfo> {
    return this.state(owner, repo).info;
  }

  async listInstallationRepositories(): Promise<GitHubRepositoryInfo[]> {
    return [...this.repositories.values()].map((state) => state.info);
  }

  async getBranchHead(_installationId: number, owner: string, repo: string, branch: string): Promise<GitHubCommitInfo> {
    const state = this.state(owner, repo);
    const sha = state.branches.get(branch);
    if (!sha) throw new GitHubError(`Demo branch not found: ${branch}`, { code: "GITHUB_HTTP_404" });
    return state.commits.get(sha)!;
  }

  async getFileContent(
    _installationId: number,
    owner: string,
    repo: string,
    path: string
  ): Promise<string | null> {
    return this.state(owner, repo).files.get(path) ?? null;
  }

  async createBranch(
    _installationId: number,
    owner: string,
    repo: string,
    branch: string,
    fromSha: string
  ): Promise<void> {
    assertSafeBranchName(branch);
    const state = this.state(owner, repo);
    if (state.branches.has(branch)) {
      throw new GitHubError(`Demo branch already exists: ${branch}`, { code: "GITHUB_HTTP_422" });
    }
    state.branches.set(branch, fromSha);
    logger.info("demo branch created", { owner, repo, branch });
  }

  async commitFiles(
    _installationId: number,
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: GitHubFileChange[]
  ): Promise<GitHubCommitInfo> {
    const state = this.state(owner, repo);
    if (!state.branches.has(branch)) {
      throw new GitHubError(`Demo branch not found: ${branch}`, { code: "GITHUB_HTTP_404" });
    }
    for (const file of files) state.files.set(file.path, file.content);
    const sha = createHash("sha1")
      .update(`${branch}:${message}:${files.map((f) => f.path).join(",")}:${state.commits.size}`)
      .digest("hex");
    const commit: GitHubCommitInfo = {
      sha,
      message,
      authorName: "Capibara (demo)",
      authorEmail: "demo@capibara.invalid",
      committedAt: new Date().toISOString(),
      url: `https://github.invalid/${owner}/${repo}/commit/${sha}`
    };
    state.commits.set(sha, commit);
    state.branches.set(branch, sha);
    logger.info("demo commit created", { owner, repo, branch, files: files.length });
    return commit;
  }

  async createPullRequest(request: CreatePullRequestRequest): Promise<GitHubPullRequestInfo> {
    const state = this.state(request.owner, request.repo);
    if (!state.branches.has(request.head)) {
      throw new GitHubError(`Demo branch not found: ${request.head}`, { code: "GITHUB_HTTP_404" });
    }
    const number = this.pullRequests.length + 1;
    const pr: GitHubPullRequestInfo = {
      id: `demo-pr-${number}`,
      number,
      title: request.title,
      url: `https://github.invalid/${request.owner}/${request.repo}/pull/${number}`,
      branch: request.head,
      baseBranch: request.base,
      status: "open",
      draft: request.draft ?? true
    };
    this.pullRequests.push(pr);
    logger.info("demo pull request opened", { owner: request.owner, repo: request.repo, number });
    return pr;
  }

  async downloadTarball(): Promise<ReadableStream<Uint8Array>> {
    throw new GitHubError("Demo mode does not provide repository tarballs", {
      code: "GITHUB_DEMO_UNSUPPORTED",
      publicMessage: "Repository download is not available in demo mode."
    });
  }

  /** Seed a file so demo runs can read a "previous" version of a document. */
  setFile(owner: string, repo: string, path: string, content: string): void {
    this.state(owner, repo).files.set(path, content);
  }

  /** Test/demo introspection. */
  listPullRequests(): readonly GitHubPullRequestInfo[] {
    return this.pullRequests;
  }

  private state(owner: string, repo: string): DemoRepositoryState {
    assertGitHubSlug(owner, "owner");
    assertGitHubSlug(repo, "repo");
    const state = this.repositories.get(`${owner}/${repo}`);
    if (!state) {
      throw new GitHubError(`Demo repository not found: ${owner}/${repo}`, { code: "GITHUB_HTTP_404" });
    }
    return state;
  }

  private seed(): void {
    const baseSha = "0000000000000000000000000000000000000001";
    const state: DemoRepositoryState = {
      info: {
        githubId: 1,
        owner: DEMO_OWNER,
        name: DEMO_REPO,
        defaultBranch: "main",
        isPrivate: false,
        url: `https://github.invalid/${DEMO_OWNER}/${DEMO_REPO}`
      },
      branches: new Map([["main", baseSha]]),
      commits: new Map([
        [
          baseSha,
          {
            sha: baseSha,
            message: "Initial demo commit",
            authorName: "Capibara (demo)",
            authorEmail: "demo@capibara.invalid",
            committedAt: new Date(0).toISOString(),
            url: `https://github.invalid/${DEMO_OWNER}/${DEMO_REPO}/commit/${baseSha}`
          }
        ]
      ]),
      files: new Map()
    };
    this.repositories.set(`${DEMO_OWNER}/${DEMO_REPO}`, state);
  }
}
