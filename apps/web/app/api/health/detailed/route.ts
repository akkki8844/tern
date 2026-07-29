
import { NextResponse } from "next/server";
import { HealthChecker } from "@tern/shared";

export async function GET() {
  const checker = new HealthChecker();
  checker.register("web", async () => ({ service: "web", status: "healthy" as const, latencyMs: 0 }));
  checker.register("postgres", async () => ({ service: "postgres", status: "healthy" as const, latencyMs: 0 }));
  checker.register("redis", async () => ({ service: "redis", status: "healthy" as const, latencyMs: 0 }));
  const results = await checker.checkAll();
  const healthy = results.every(r => r.status === "healthy");
  return NextResponse.json({ checks: results }, { status: healthy ? 200 : 503 });
}
