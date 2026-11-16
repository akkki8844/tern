import { toCapibaraError, type CapibaraError } from "./errors.js";

export interface BackoffOptions {
  /** Delay before the second attempt. */
  baseDelayMs: number;
  /** Upper bound for any single delay. */
  maxDelayMs: number;
  /** Multiplier applied per attempt. */
  factor?: number;
  /** Fraction of the delay applied as random jitter (0..1). Defaults to 0.2. */
  jitter?: number;
}

/**
 * Exponential backoff with full-width jitter, deterministic when `random` is supplied.
 * `attempt` is 1-based: attempt 1 is the first retry delay.
 */
export function backoffDelay(attempt: number, options: BackoffOptions, random: () => number = Math.random): number {
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.2;
  const raw = options.baseDelayMs * Math.pow(factor, Math.max(0, attempt - 1));
  const capped = Math.min(raw, options.maxDelayMs);
  const spread = capped * jitter;
  const delta = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(capped + delta));
}

export interface RetryOptions extends Partial<BackoffOptions> {
  maxAttempts?: number;
  /** Decide whether a failure is worth retrying. Defaults to `CapibaraError.retryable`. */
  isRetryable?: (error: unknown) => boolean;
  /** Called before sleeping. Useful for structured logging. */
  onRetry?: (info: { attempt: number; delayMs: number; error: CapibaraError }) => void;
  /** Injected sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Retry an async operation. Only errors the predicate marks retryable are retried;
 * everything else fails fast. The original error is always preserved.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoff: BackoffOptions = {
    baseDelayMs: options.baseDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 30_000,
    factor: options.factor ?? 2,
    jitter: options.jitter ?? 0.2
  };
  const isRetryable = options.isRetryable ?? ((error: unknown) => toCapibaraError(error).retryable);
  const doSleep = options.sleep ?? ((ms: number) => sleep(ms, options.signal));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      const delayMs = backoffDelay(attempt, backoff);
      options.onRetry?.({ attempt, delayMs, error: toCapibaraError(error) });
      await doSleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Run `fn` with a hard deadline. The AbortSignal is forwarded so well behaved clients
 * (fetch, child_process) can cancel their own work instead of leaking.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => Error
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw onTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
