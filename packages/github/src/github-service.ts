import { App, Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { getConfig, RepositoryRef } from "@tern/shared";
import {
  GitHubService,
  GitHubRepository,
  GitHubCommit,
  GitHubBranch,
  GitHubPullRequest,
  CreatePullRequestInput
} from "./interfaces.js";

export class OctokitGitHubService implements GitHubService {
  private app?: App;
  private config = getConfig();
  private octokitCache = new Map<number, Octokit>();

  constructor() {
    if (this.config.GITHUB_APP_ID && this.config.GITHUB_PRIVATE_KEY) {
      this.app = new App({
        appId: this.config.GITHUB_APP_ID,
        privateKey: this.config.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n")
      });
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.app && this.config.GITHUB_APP_ID && this.config.GITHUB_PRIVATE_KEY);
  }

  private getOctokitForInstallation(installationId: number): Octokit {
    if (!this.app) throw new Error("GitHub App not configured");
    if (this.octokitCache.has(installationId)) return this.octokitCache.get(installationId)!;
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.config.GITHUB_APP_ID!, privateKey: this.config.GITHUB_PRIVATE_KEY!.replace(/\\n/g, "\n"), installationId }
    });
    this.octokitCache.set(installationId, octokit);
    return octokit;
  }

  async verifyWebhook(payload: string, signature: string, secret: string): Promise<boolean> {
    const { createHmac } = await import("crypto");
    const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    return expected === signature;
  }

  async createInstallationToken(installationId: number): Promise<string> {
    if (!this.app) throw new Error("GitHub App not configured");
    const { data } = await this.app.octokit.request("POST /app/installations/{installation_id}/access_tokens", { installation_id: installationId });
    return data.token;
  }

  async listRepositories(installationId: number): Promise<GitHubRepository[]> {
    const octokit = this.getOctokitForInstallation(installationId);
    const repos: GitHubRepository[] = [];
    for await (const response of octokit.paginate.iterator(octokit.rest.apps.listReposAccessibleToInstallation, { installation_id: installationId })) {
      for (const r of response.data as any[]) {
        repos.push(this.toGitHubRepository(r));
      }
    }
    return repos;
  }

  async getRepository(installationId: number, owner: string, repo: string): Promise<GitHubRepository> {
    const octokit = this.getOctokitForInstallation(installationId);
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return this.toGitHubRepository(data);
  }

  async getDefaultBranch(installationId: number, owner: string, repo: string): Promise<string> {
    const repoData = await this.getRepository(installationId, owner, repo);
    return repoData.defaultBranch;
  }

  async getLatestCommit(installationId: number, owner: string, repo: string, branch: string): Promise<GitHubCommit> {
    const octokit = this.getOctokitForInstallation(installationId);
    const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
    const commit = (data as any).commit;
    return {
      sha: commit.sha,
      message: commit.commit.message,
      author: { name: commit.commit.author.name, email: commit.commit.author.email, date: commit.commit.author.date },
      url: commit.html_url
    };
  }

  async createBranch(installationId: number, owner: string, repo: string, branch: string, baseSha: string): Promise<GitHubBranch> {
    const octokit = this.getOctokitForInstallation(installationId);
    const { data } = await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
    return { name: branch, commitSha: data.object.sha };
  }

  async createCommit(installationId: number, owner: string, repo: string, branch: string, message: string, files: Record<string, string>): Promise<GitHubCommit> {
    const octokit = this.getOctokitForInstallation(installationId);
    const { data: latest } = await octokit.rest.repos.getBranch({ owner, repo, branch });
    const baseSha = latest.commit.sha;
    const treeEntries = [];
    for (const [path, content] of Object.entries(files)) {
      const { data: blob } = await octokit.rest.git.createBlob({ owner, repo, content: Buffer.from(content).toString("base64"), encoding: "base64" });
      treeEntries.push({ path, mode: "100644" as const, type: "blob" as const, sha: blob.sha });
    }
    const { data: tree } = await octokit.rest.git.createTree({ owner, repo, base_tree: baseSha, tree: treeEntries });
    const { data: newCommit } = await octokit.rest.git.createCommit({ owner, repo, message, tree: tree.sha, parents: [baseSha] });
    await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha });
    return { sha: newCommit.sha, message, author: { name: "Tern", email: "tern@noreply.github.com", date: new Date().toISOString() }, url: newCommit.html_url };
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    const octokit = this.getOctokitForInstallation(input.installationId);
    const { data } = await octokit.rest.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base
    });
    return { id: String(data.id), number: data.number, title: data.title, body: data.body || "", url: data.html_url, branch: input.head, baseBranch: input.base, status: data.state === "closed" ? "closed" : "open" };
  }

  toGitHubRepository(data: any): GitHubRepository {
    return {
      id: data.id,
      owner: data.owner.login,
      name: data.name,
      defaultBranch: data.default_branch,
      isPrivate: data.private,
      url: data.html_url
    };
  }

  toRepositoryRef(repo: GitHubRepository, installationId: number): RepositoryRef {
    return {
      id: `repo:${repo.owner}:${repo.name}`,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      installationId,
      isPrivate: repo.isPrivate,
      url: repo.url
    } as RepositoryRef;
  }
}

export async function createGitHubService(): Promise<GitHubService> {
  const config = getConfig();
  if (config.DEMO_MODE || !config.GITHUB_APP_ID || !config.GITHUB_PRIVATE_KEY) {
    const { MockGitHubService } = await import("./mock-github-service");
    return new MockGitHubService();
  }
  return new OctokitGitHubService();
}
