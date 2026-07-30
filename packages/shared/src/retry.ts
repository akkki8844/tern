
import { getLogger } from "./logger";
const logger = getLogger("retry");

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  retryable?: (err: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 1000;
  const backoffMultiplier = options.backoffMultiplier ?? 2;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const retryable = options.retryable ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !retryable(err)) throw err;
      const wait = Math.min(delayMs * Math.pow(backoffMultiplier, attempt - 1), maxDelayMs);
      logger.warn("retrying operation", { attempt, waitMs: wait });
      await sleep(wait);
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
