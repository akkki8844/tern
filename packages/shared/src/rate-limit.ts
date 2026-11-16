/**
 * In-process fixed-window rate limiter.
 *
 * Scope: protects a single process against obvious abuse (for example repeated
 * unauthenticated webhook or OAuth callback attempts). It is deliberately NOT a
 * distributed limiter — durable, cross-instance limiting belongs in the database
 * or an edge proxy and is out of scope for the core runtime.
 */
export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  check(key: string): RateLimitDecision {
    const now = this.now();
    this.sweep(now);

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    if (bucket.count >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this.maxRequests - bucket.count, resetAt: bucket.resetAt };
  }

  /** Drop expired buckets so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
