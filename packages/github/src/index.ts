import { getEnv } from "@/packages/shared/src/env";
import { createDemoGitHubAppClient } from "@/packages/github/src/demo-client";
import { createProductionGitHubAppClient } from "@/packages/github/src/production-client";
import type { GitHubAppClient } from "@/packages/github/src/types";

async function notConfiguredTokenProvider(): Promise<string> {
  throw new Error("Installation token provider is not configured. Set GitHub App credentials and installation token flow.");
}

let githubClient: GitHubAppClient | null = null;

export function getGitHubClient(): GitHubAppClient {
  if (githubClient) {
    return githubClient;
  }

  const env = getEnv();
  githubClient = env.TERN_DEMO_MODE === "true" ? createDemoGitHubAppClient() : createProductionGitHubAppClient(notConfiguredTokenProvider);

  return githubClient;
}

export * from "@/packages/github/src/types";
