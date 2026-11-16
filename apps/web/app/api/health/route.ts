import { NextResponse } from "next/server";
import { serverConfig } from "../_runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness: the process is up. Deliberately does not touch the database. */
export async function GET(): Promise<NextResponse> {
  const config = serverConfig();
  return NextResponse.json({
    status: "healthy",
    service: config.logging.serviceName,
    demoMode: config.demoMode,
    timestamp: new Date().toISOString()
  });
}
