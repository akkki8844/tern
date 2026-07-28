import { NextRequest, NextResponse } from "next/server";
import { verifyGitHubSignature } from "@/lib/github/app";
import { errorResponse, logger, TernError } from "@/packages/shared/src";

export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get("x-hub-signature-256");
    const payload = await request.text();

    if (!signature) {
      throw new TernError("AUTH_ERROR", "Missing webhook signature", 401);
    }

    const verified = await verifyGitHubSignature(payload, signature);
    if (!verified) {
      throw new TernError("AUTH_ERROR", "Invalid webhook signature", 401);
    }

    logger.info("github_webhook_verified", {
      event: request.headers.get("x-github-event") ?? "unknown",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("github_webhook_failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return errorResponse(error);
  }
}
