
import { createHmac } from "crypto";
import { RepositoryRef } from "@tern/shared";
import {
  GitHubService,
  GitHubRepository,
  GitHubCommit,
  GitHubBranch,
  GitHubPullRequest,
  CreatePullRequestInput
} from "./interfaces";

export class MockGitHubService implements GitHubService {
  private repos = new Map<string, GitHubRepository>();
  private branches = new Map<string, GitHubBranch>();
  private commits = new Map<string, GitHubCommit>();
  private prCounter = 1;
  private prs = new Map<string, GitHubPullRequest>();

  constructor() {
    const repo: GitHubRepository = {
      id: 123456789,
      owner: "tern-demo",
      name: "acmepay-demo",
      defaultBranch: "main",
      isPrivate: false,
      url: "https://github.com/tern-demo/acmepay-demo"
    };
    this.repos.set("tern-demo/acmepay-demo", repo);
    this.branches.set("main", { name: "main", commitSha: "abc123" });
    this.commits.set("abc123", { sha: "abc123", message: "Initial commit", author: { name: "Demo", email: "demo@tern.dev", date: new Date().toISOString() }, url: "https://github.com/tern-demo/acmepay-demo/commit/abc123" });
  }

  verifyWebhook(payload: string, signature: string, secret: string): boolean {
    const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    return expected === signature;
  }

  async createInstallationToken(_installationId: number): Promise<string> { return "mock-token"; }

  async listRepositories(_installationId: number): Promise<GitHubRepository[]> {
    return Array.from(this.repos.values());
  }

  async getRepository(_installationId: number, owner: string, repo: string): Promise<GitHubRepository> {
    const key = `${owner}/${repo}`;
    const r = this.repos.get(key);
    if (!r) throw new Error(`Repository not found: ${key}`);
    return r;
  }

  async getDefaultBranch(_installationId: number, owner: string, repo: string): Promise<string> {
    return (await this.getRepository(0, owner, repo)).defaultBranch;
  }

  async getLatestCommit(_installationId: number, owner: string, repo: string, branch: string): Promise<GitHubCommit> {
    const key = `${owner}/${repo}:${branch}`;
    return this.commits.get(branch) || this.commits.get("main")!;
  }

  async createBranch(_installationId: number, owner: string, repo: string, branch: string, baseSha: string): Promise<GitHubBranch> {
    const b = { name: branch, commitSha: baseSha };
    this.branches.set(`${owner}/${repo}:${branch}`, b);
    return b;
  }

  async createCommit(_installationId: number, owner: string, repo: string, branch: string, message: string, files: Record<string, string>): Promise<GitHubCommit> {
    const sha = `mock-${Date.now()}`;
    const commit: GitHubCommit = { sha, message, author: { name: "Tern", email: "tern@noreply.github.com", date: new Date().toISOString() }, url: `https://github.com/${owner}/${repo}/commit/${sha}` };
    this.commits.set(sha, commit);
    this.branches.set(`${owner}/${repo}:${branch}`, { name: branch, commitSha: sha });
    return commit;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    const pr: GitHubPullRequest = {
      id: `pr-${this.prCounter}`,
      number: this.prCounter++,
      title: input.title,
      body: input.body,
      url: `https://github.com/${input.owner}/${input.repo}/pull/${this.prCounter - 1}`,
      branch: input.head,
      baseBranch: input.base,
      status: "open"
    };
    this.prs.set(pr.id, pr);
    return pr;
  }

  toRepositoryRef(repo: GitHubRepository, installationId: number): RepositoryRef {
    return {
      id: `repo:${repo.owner}:${repo.name}` as RepositoryRef,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      installationId: installationId as unknown as import("@tern/shared").InstallationId,
      isPrivate: repo.isPrivate,
      url: repo.url
    };
  }
}
