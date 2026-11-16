import { ConfigurationError, getLogger, type GitHubProvider, type CapibaraConfig } from "@capibara/shared";
import { GitHubAppProvider } from "./github-app-provider.js";
import { DemoGitHubProvider } from "./demo-github-provider.js";

const logger = getLogger("github-factory");

/**
 * Select the GitHub implementation for the current runtime.
 *
 * The choice is explicit and logged. There is no silent fallback from a real
 * provider to the demo provider: in a non-demo runtime, missing credentials are a
 * configuration error, not a reason to quietly stop doing real work.
 */
export function createGitHubProvider(config: CapibaraConfig): GitHubProvider {
  if (config.demoMode) {
    logger.info("using demo GitHub provider", { reason: "CAPIBARA_MODE=demo" });
    return new DemoGitHubProvider(config.githubApp.enabled ? config.githubApp.webhookSecret : undefined);
  }

  if (!config.githubApp.enabled) {
    throw new ConfigurationError(
      "GitHub App credentials are required outside demo mode. Set GITHUB_APP_ID, GITHUB_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET, or set CAPIBARA_MODE=demo.",
      { code: "GITHUB_APP_NOT_CONFIGURED" }
    );
  }

  logger.info("using GitHub App provider", { appId: config.githubApp.appId, apiBaseUrl: config.githubApp.apiBaseUrl });
  return new GitHubAppProvider(config.githubApp);
}
