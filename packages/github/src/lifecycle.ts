
import { getLogger } from "@tern/shared";
const logger = getLogger("github-lifecycle");

export interface WebhookPayload {
  event: string;
  action?: string;
  installation?: { id: number; account?: { id: number; login: string } };
  repositories?: Array<{ id: number; full_name: string }>;
  repository?: { id: number; full_name: string; default_branch: string; private: boolean; html_url: string };
}

export interface InstallationResult {
  installed: boolean;
  installationId: number;
  accountLogin: string;
  repositories?: Array<{ id: number; owner: string; name: string }>;
}

export interface RepositoryEvent {
  event: "added" | "removed";
  installationId: number;
  repositories: Array<{ id: number; owner: string; name: string; defaultBranch: string; isPrivate: boolean; url: string }>;
}

export class GitHubAppLifecycle {
  handleInstallation(payload: WebhookPayload): InstallationResult {
    const installationId = payload.installation?.id ?? 0;
    const accountLogin = payload.installation?.account?.login ?? "unknown";
    logger.info({ installationId, accountLogin, action: payload.action }, "installation event");
    const repos = payload.repositories?.map(r => {
      const [owner, name] = r.full_name.split("/");
      return { id: r.id, owner, name };
    });
    return { installed: payload.action !== "deleted", installationId, accountLogin, repositories: repos };
  }

  handleRepositories(payload: WebhookPayload): RepositoryEvent {
    const installationId = payload.installation?.id ?? 0;
    const event: RepositoryEvent["event"] = payload.action === "removed" ? "removed" : "added";
    const repos = payload.repositories?.map(r => {
      const [owner, name] = r.full_name.split("/");
      return { id: r.id, owner, name, defaultBranch: "main", isPrivate: false, url: `https://github.com/${owner}/${name}` };
    }) ?? [];
    logger.info({ installationId, event, repoCount: repos.length }, "repositories event");
    return { event, installationId, repositories: repos };
  }
}
