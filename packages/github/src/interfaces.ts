
import { RepositoryRef } from "@tern/shared";

export interface GitHubInstallation {
  id: number;
  accountId: string;
  accountLogin: string;
  suspendedAt?: Date;
  deletedAt?: Date;
  createdAt: Date;
}

export interface GitHubRepository {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  url: string;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string };
  url: string;
}

export interface GitHubBranch {
  name: string;
  commitSha: string;
}

export interface GitHubPullRequest {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  branch: string;
  baseBranch: string;
  status: "open" | "closed" | "merged";
}

export interface CreatePullRequestInput {
  installationId: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface GitHubService {
  verifyWebhook(payload: string, signature: string, secret: string): boolean;
  createInstallationToken(installationId: number): Promise<string>;
  listRepositories(installationId: number): Promise<GitHubRepository[]>;
  getRepository(installationId: number, owner: string, repo: string): Promise<GitHubRepository>;
  getDefaultBranch(installationId: number, owner: string, repo: string): Promise<string>;
  getLatestCommit(installationId: number, owner: string, repo: string, branch: string): Promise<GitHubCommit>;
  createBranch(installationId: number, owner: string, repo: string, branch: string, baseSha: string): Promise<GitHubBranch>;
  createCommit(installationId: number, owner: string, repo: string, branch: string, message: string, files: Record<string, string>): Promise<GitHubCommit>;
  createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>;
  toRepositoryRef(repo: GitHubRepository, installationId: number): RepositoryRef;
}
