import { NextResponse } from "next/server";
import { createGitHubService } from "@tern/github";
import { getConfig } from "@tern/shared";

export async function POST(request: Request) {
  try {
    const payload = await request.text();
    const signature = request.headers.get("x-hub-signature-256") || "";
    const config = getConfig();
    const github = await createGitHubService();
    const valid = await github.verifyWebhook(payload, signature, config.GITHUB_WEBHOOK_SECRET);
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    return NextResponse.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
