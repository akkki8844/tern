
import { NextResponse } from "next/server";
import { HealthChecker } from "@tern/shared";

export async function GET() {
  const checker = new HealthChecker();
  checker.register("web", async () => ({ service: "web", status: "healthy" as const, latencyMs: 0 }));
  return NextResponse.json({ status: "ok", checks: await checker.checkAll() });
}
