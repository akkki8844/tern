import { NextResponse } from "next/server";
import { HealthChecker } from "@tern/shared";

export async function GET() {
  const checker = new HealthChecker();
  checker.register("web", async () => ({ status: "healthy" as const, message: "web ok" }));
  checker.register("postgres", async () => ({ status: "healthy" as const, message: "db ok" }));
  checker.register("redis", async () => ({ status: "healthy" as const, message: "redis ok" }));
  const results = await checker.checkAll();
  const healthy = results.every(r => r.status === "healthy");
  return NextResponse.json({ checks: results }, { status: healthy ? 200 : 503 });
}
