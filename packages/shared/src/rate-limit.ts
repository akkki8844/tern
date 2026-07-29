
export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private store = new Map<string, RateLimitEntry>();
  constructor(private maxRequests: number, private windowMs: number) {}

  isAllowed(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let entry = this.store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.store.set(key, entry);
    }
    const allowed = entry.count < this.maxRequests;
    if (allowed) entry.count += 1;
    return { allowed, remaining: Math.max(0, this.maxRequests - entry.count), resetAt: entry.resetAt };
  }
}
