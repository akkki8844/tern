import { getGitHubClient } from "@/packages/github/src";

export async function verifyGitHubSignature(payload: string, signature: string): Promise<boolean> {
  const client = getGitHubClient();
  return client.verifyWebhookSignature(payload, signature);
}
