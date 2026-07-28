import { NextRequest, NextResponse } from "next/server";
import { verifyGitHubSignature } from "@/lib/github/app";

export async function POST(request: NextRequest) {
  const signature = request.headers.get("x-hub-signature-256");
  const payload = await request.text();

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const verified = await verifyGitHubSignature(payload, signature);
  if (!verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
