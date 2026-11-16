import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, revokeSession } from "../../_session";
import { serverConfig } from "../../_runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out. POST-only so a cross-site GET cannot log a user out. */
export async function POST(): Promise<NextResponse> {
  serverConfig();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  store.delete(SESSION_COOKIE);
  return NextResponse.json({ status: "signed-out" });
}
