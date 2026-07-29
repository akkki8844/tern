
import { NextResponse } from "next/server";
import { MockGitHubService, GitHubAppLifecycle } from "@tern/github";
import { getConfig } from "@tern/shared";

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const event = request.headers.get("x-github-event") ?? "";
  const cfg = getConfig();
  const github = new MockGitHubService();
  if (!github.verifyWebhook(body, signature, cfg.GITHUB_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  const payload = JSON.parse(body);
  const lifecycle = new GitHubAppLifecycle();
  if (event === "installation") {
    lifecycle.handleInstallation(payload);
  } else if (event === "installation_repositories") {
    lifecycle.handleRepositories(payload);
  }
  return NextResponse.json({ received: true });
}
