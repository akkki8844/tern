import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";

export function createWebhookVerifier() {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing GITHUB_WEBHOOK_SECRET");
  return new Webhooks({ secret });
}

export function createInstallationClient(installationToken: string) {
  return new Octokit({ auth: installationToken });
}

export async function verifyGitHubSignature(payload: string, signature: string): Promise<boolean> {
  const verifier = createWebhookVerifier();
  return verifier.verify(payload, signature);
}
