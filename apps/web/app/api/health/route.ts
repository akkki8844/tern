import { NextResponse } from "next/server";
import { HealthChecker } from "@tern/shared";

export async function GET() {
  const checker = new HealthChecker();
  checker.register("web", async () => ({ status: "healthy" as const, message: "web ok" }));
  return NextResponse.json({ status: "ok", checks: await checker.checkAll() });
}
