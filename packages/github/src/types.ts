export type InstallationRepository = {
  githubRepoId: number;
  fullName: string;
  defaultBranch: string;
};

export type PullRequestInput = {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
};

export type PullRequestOutput = {
  number: number;
  url: string;
};

export type GitHubAppClient = {
  verifyWebhookSignature: (payload: string, signature: string) => Promise<boolean>;
  listInstallationRepositories: (installationId: number) => Promise<InstallationRepository[]>;
  createBranch: (params: { owner: string; repo: string; branch: string; sha: string }) => Promise<void>;
  commitFiles: (params: {
    owner: string;
    repo: string;
    branch: string;
    message: string;
    files: Array<{ path: string; content: string }>;
  }) => Promise<void>;
  createPullRequest: (input: PullRequestInput) => Promise<PullRequestOutput>;
};
