import type { HealthCheckResult, HealthReport } from "./types.js";
import { internalMessageOf } from "./errors.js";

export type HealthCheck = () => Promise<{ status: "healthy" | "degraded" | "unhealthy"; message?: string } | boolean>;

/**
 * Minimal health registry. Checks are executed in parallel with a per-check timeout
 * so one hanging dependency cannot block the health endpoint.
 */
export class HealthRegistry {
  private readonly checks = new Map<string, { check: HealthCheck; timeoutMs: number }>();

  register(name: string, check: HealthCheck, timeoutMs = 2_000): this {
    this.checks.set(name, { check, timeoutMs });
    return this;
  }

  async run(): Promise<HealthReport> {
    const results = await Promise.all(
      [...this.checks.entries()].map(([name, { check, timeoutMs }]) => runOne(name, check, timeoutMs))
    );
    const status = results.some((r) => r.status === "unhealthy")
      ? "unhealthy"
      : results.some((r) => r.status === "degraded")
        ? "degraded"
        : "healthy";
    return { status, checks: results };
  }
}

async function runOne(name: string, check: HealthCheck, timeoutMs: number): Promise<HealthCheckResult> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const outcome = await Promise.race([check(), timeout]);
    const latencyMs = Date.now() - start;
    if (typeof outcome === "boolean") {
      return { name, status: outcome ? "healthy" : "unhealthy", latencyMs };
    }
    return { name, status: outcome.status, latencyMs, message: outcome.message };
  } catch (error) {
    return { name, status: "unhealthy", latencyMs: Date.now() - start, message: internalMessageOf(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
