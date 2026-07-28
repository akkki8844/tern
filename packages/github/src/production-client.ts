import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";
import { requireSecrets } from "@/packages/shared/src/env";
import { TernError } from "@/packages/shared/src/errors";
import type { GitHubAppClient, InstallationRepository, PullRequestInput, PullRequestOutput } from "@/packages/github/src/types";

function getWebhookVerifier() {
  requireSecrets(["GITHUB_WEBHOOK_SECRET"]);
  return new Webhooks({ secret: process.env.GITHUB_WEBHOOK_SECRET! });
}

function getInstallationClient(token: string) {
  return new Octokit({ auth: token });
}

export function createProductionGitHubAppClient(tokenProvider: (installationId: number) => Promise<string>): GitHubAppClient {
  return {
    async verifyWebhookSignature(payload, signature) {
      return getWebhookVerifier().verify(payload, signature);
    },

    async listInstallationRepositories(installationId): Promise<InstallationRepository[]> {
      const token = await tokenProvider(installationId);
      const octokit = getInstallationClient(token);
      const response = await octokit.apps.listReposAccessibleToInstallation();
      return response.data.repositories.map((repo) => ({
        githubRepoId: repo.id,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
      }));
    },

    async createBranch({ owner, repo, branch, sha }) {
      if (!branch.startsWith("tern/api-migration-")) {
        throw new TernError("VALIDATION_ERROR", "Branch name must start with tern/api-migration-", 400);
      }

      const token = await tokenProvider(0);
      const octokit = getInstallationClient(token);
      await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha });
    },

    async commitFiles({ owner, repo, branch, message, files }) {
      const token = await tokenProvider(0);
      const octokit = getInstallationClient(token);
      const current = await octokit.repos.getBranch({ owner, repo, branch });
      const baseCommitSha = current.data.commit.sha;
      const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: baseCommitSha });

      const tree = await octokit.git.createTree({
        owner,
        repo,
        base_tree: baseCommit.data.tree.sha,
        tree: files.map((file) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          content: file.content,
        })),
      });

      const commit = await octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: tree.data.sha,
        parents: [baseCommitSha],
      });

      await octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha });
    },

    async createPullRequest(input: PullRequestInput): Promise<PullRequestOutput> {
      const token = await tokenProvider(0);
      const octokit = getInstallationClient(token);
      const response = await octokit.pulls.create(input);
      return { number: response.data.number, url: response.data.html_url };
    },
  };
}
