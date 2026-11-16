import { NextResponse } from "next/server";
import { getSessionUser } from "../../_session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current user, or 401. Used by the UI to decide what to render. */
export async function GET(): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in required." } }, { status: 401 });
  }
  return NextResponse.json({ user });
}
