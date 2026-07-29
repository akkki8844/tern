
export interface HealthCheck {
  service: string;
  status: "healthy" | "unhealthy";
  latencyMs: number;
  message?: string;
}

export type HealthCheckFn = () => Promise<HealthCheck>;

export class HealthChecker {
  private checks: Map<string, HealthCheckFn> = new Map();
  register(name: string, fn: HealthCheckFn): this {
    this.checks.set(name, fn);
    return this;
  }
  async check(name: string): Promise<HealthCheck> {
    const fn = this.checks.get(name);
    if (!fn) return { service: name, status: "unhealthy", latencyMs: 0, message: "Unknown service" };
    const start = Date.now();
    try {
      const result = await fn();
      return { ...result, latencyMs: Date.now() - start };
    } catch (err) {
      return { service: name, status: "unhealthy", latencyMs: Date.now() - start, message: err instanceof Error ? err.message : String(err) };
    }
  }
  async checkAll(): Promise<HealthCheck[]> {
    const results: HealthCheck[] = [];
    for (const name of this.checks.keys()) {
      results.push(await this.check(name));
    }
    return results;
  }
}
