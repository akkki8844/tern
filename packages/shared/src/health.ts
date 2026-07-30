import { HealthCheck, HealthCheckResult } from "./types";

export class HealthChecker {
  private checks: Map<string, HealthCheck> = new Map();

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  async checkAll(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    for (const [name, check] of this.checks.entries()) {
      const start = Date.now();
      try {
        const r = await check();
        if (typeof r === "boolean") {
          results.push({ service: name, status: r ? "healthy" : "unhealthy", latencyMs: Date.now() - start });
        } else {
          results.push({ service: name, status: r.status || (r ? "healthy" : "unhealthy"), latencyMs: Date.now() - start, message: r.message });
        }
      } catch (e) {
        results.push({
          service: name,
          status: "unhealthy",
          latencyMs: Date.now() - start,
          message: e instanceof Error ? e.message : String(e)
        });
      }
    }
    return results;
  }
}

export class CompositeHealthChecker {
  private checks: Map<string, () => Promise<boolean | { status: string; message?: string }>> = new Map();

  constructor(initial?: Record<string, () => Promise<boolean | { status: string; message?: string }>>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.checks.set(k, v);
      }
    }
  }

  register(name: string, check: () => Promise<boolean | { status: string; message?: string }>): void {
    this.checks.set(name, check);
  }

  async check(): Promise<{ status: string; checks: Record<string, { status: string; message?: string }> }> {
    const results: Record<string, { status: string; message?: string }> = {};
    let overall = true;
    for (const [name, check] of this.checks.entries()) {
      try {
        const r = await check();
        if (typeof r === "boolean") {
          results[name] = { status: r ? "healthy" : "unhealthy" };
          if (!r) overall = false;
        } else {
          results[name] = { status: r.status, message: r.message };
          if (r.status !== "healthy") overall = false;
        }
      } catch (e) {
        results[name] = { status: "unhealthy", message: e instanceof Error ? e.message : String(e) };
        overall = false;
      }
    }
    return { status: overall ? "healthy" : "unhealthy", checks: results };
  }
}
