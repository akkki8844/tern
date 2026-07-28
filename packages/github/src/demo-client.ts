import type { GitHubAppClient, InstallationRepository, PullRequestInput, PullRequestOutput } from "@/packages/github/src/types";

const demoRepositories: InstallationRepository[] = [
  { githubRepoId: 1001, fullName: "demo/acmepay", defaultBranch: "main" },
];

export function createDemoGitHubAppClient(): GitHubAppClient {
  return {
    async verifyWebhookSignature() {
      return true;
    },
    async listInstallationRepositories() {
      return demoRepositories;
    },
    async createBranch() {
      return;
    },
    async commitFiles() {
      return;
    },
    async createPullRequest(input: PullRequestInput): Promise<PullRequestOutput> {
      return {
        number: 42,
        url: `https://github.com/${input.owner}/${input.repo}/pull/42`,
      };
    },
  };
}
