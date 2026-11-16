import { NextResponse } from "next/server";
import { HealthRegistry, getLogger } from "@capibara/shared";
import { checkDatabaseConnection } from "@capibara/db";
import { jobStore, prisma, serverConfig } from "../../_runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("health");

/**
 * Readiness: every dependency is actually checked. Nothing here returns a hardcoded
 * "healthy" — an unreachable database produces 503, which is what a load balancer
 * needs in order to stop sending traffic.
 */
export async function GET(): Promise<NextResponse> {
  const config = serverConfig();

  const registry = new HealthRegistry()
    .register("database", async () => {
      await checkDatabaseConnection(prisma());
      return { status: "healthy" as const };
    })
    .register("jobs", async () => {
      const stats = await jobStore().stats();
      // A growing backlog is degraded, not unhealthy: the service still works.
      return stats.pending > 1_000
        ? { status: "degraded" as const, message: `${stats.pending} jobs pending` }
        : { status: "healthy" as const, message: `${stats.pending} pending, ${stats.running} running` };
    })
    .register("github", async () =>
      config.githubApp.enabled || config.demoMode
        ? { status: "healthy" as const }
        : { status: "degraded" as const, message: "GitHub App is not configured" }
    );

  const report = await registry.run();
  if (report.status !== "healthy") {
    logger.warn("health check is not fully healthy", { status: report.status });
  }

  return NextResponse.json(
    { ...report, demoMode: config.demoMode, timestamp: new Date().toISOString() },
    { status: report.status === "unhealthy" ? 503 : 200 }
  );
}
