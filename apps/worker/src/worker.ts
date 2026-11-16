import { randomUUID } from "node:crypto";
import {
  JobError,
  getLogger,
  isCapibaraError,
  toCapibaraError,
  type Logger,
  type WorkerConfig
} from "@capibara/shared";
import type { JobRecord, JobStore } from "@capibara/jobs";

export interface JobContext {
  readonly job: JobRecord;
  readonly logger: Logger;
  /** Aborted when the job is cancelled or the worker is shutting down. */
  readonly signal: AbortSignal;
  /** Renew the lease. Throws if the lease has been lost. */
  heartbeat(): Promise<void>;
}

export interface JobHandler {
  readonly type: string;
  /** Maximum attempts for jobs of this type, used when enqueuing. */
  handle(context: JobContext): Promise<unknown>;
}

export interface WorkerHooks {
  onJobStarted?(job: JobRecord): void;
  onJobFinished?(job: JobRecord, outcome: "SUCCEEDED" | "FAILED" | "CANCELLED"): void;
  onIdle?(): void;
}

export interface WorkerOptions {
  store: JobStore;
  handlers: JobHandler[];
  config: WorkerConfig;
  logger?: Logger;
  hooks?: WorkerHooks;
  /** Injected for tests. */
  now?: () => number;
}

const RECLAIM_INTERVAL_FACTOR = 0.5;

/**
 * Worker runtime.
 *
 * Lifecycle
 *  - `start()` recovers jobs abandoned by previous crashed workers, then begins polling
 *  - each poll claims at most (concurrency - inFlight) jobs in one atomic statement
 *  - each running job renews its lease on a timer; losing the lease aborts the job
 *  - `stop()` stops claiming, waits for in-flight jobs up to the shutdown timeout,
 *    then cancels them; anything still stuck is recovered by the next worker via
 *    lease expiry, so a job is never lost and never silently duplicated
 *  - the poll loop sleeps between polls and wakes immediately on shutdown: there is
 *    no busy loop and no unbounded query rate
 */
export class Worker {
  private readonly store: JobStore;
  private readonly handlers: Map<string, JobHandler>;
  private readonly config: WorkerConfig;
  private readonly logger: Logger;
  private readonly hooks: WorkerHooks;

  private running = false;
  private stopping = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private lastReclaimAt = 0;
  private readonly inFlight = new Map<string, { promise: Promise<void>; controller: AbortController }>();

  constructor(options: WorkerOptions) {
    this.store = options.store;
    this.config = options.config;
    this.logger = (options.logger ?? getLogger("worker")).child({ workerId: options.config.id });
    this.hooks = options.hooks ?? {};
    this.handlers = new Map();
    for (const handler of options.handlers) {
      if (this.handlers.has(handler.type)) {
        throw new JobError(`Duplicate handler registered for job type "${handler.type}"`, {
          code: "WORKER_DUPLICATE_HANDLER"
        });
      }
      this.handlers.set(handler.type, handler);
    }
    if (this.handlers.size === 0) {
      throw new JobError("A worker must register at least one job handler", { code: "WORKER_NO_HANDLERS" });
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    // Recover anything a previous process left behind before taking new work.
    const recovered = await this.store.reclaimExpired();
    if (recovered.requeued.length || recovered.exhausted.length) {
      this.logger.warn("recovered abandoned jobs at startup", {
        requeued: recovered.requeued.length,
        exhausted: recovered.exhausted.length
      });
    }

    this.logger.info("worker started", {
      types: [...this.handlers.keys()],
      concurrency: this.config.concurrency,
      pollIntervalMs: this.config.pollIntervalMs,
      leaseDurationMs: this.config.leaseDurationMs
    });

    this.loop = this.runLoop();
  }

  /**
   * Graceful shutdown. Resolves once every in-flight job has finished or been
   * cancelled, or the shutdown timeout has elapsed.
   */
  async stop(reason = "shutdown"): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.wake?.();
    this.logger.info("worker stopping", { reason, inFlight: this.inFlight.size });

    const deadline = Date.now() + this.config.shutdownTimeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise)),
        sleep(100)
      ]);
    }

    if (this.inFlight.size > 0) {
      this.logger.warn("cancelling jobs that did not finish within the shutdown grace period", {
        inFlight: this.inFlight.size
      });
      for (const entry of this.inFlight.values()) entry.controller.abort();
      await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise));
    }

    this.running = false;
    await this.loop?.catch(() => undefined);
    this.logger.info("worker stopped", { reason });
  }

  /** Single poll iteration. Exposed for deterministic tests. */
  async tick(): Promise<number> {
    await this.maybeReclaim();

    const capacity = this.config.concurrency - this.inFlight.size;
    if (capacity <= 0) return 0;

    const jobs = await this.store.claim({
      types: [...this.handlers.keys()],
      workerId: this.config.id,
      leaseDurationMs: this.config.leaseDurationMs,
      limit: capacity
    });

    for (const job of jobs) this.spawn(job);
    return jobs.length;
  }

  /** Wait until every in-flight job settles. Test helper. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise));
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const claimed = await this.tick();
        if (claimed === 0) {
          this.hooks.onIdle?.();
          await this.idle();
        }
      } catch (error) {
        // A failing poll must not kill the worker, but it must back off so a broken
        // database does not turn into a tight retry loop.
        this.logger.failure("poll failed", error);
        await this.idle();
      }
    }
  }

  /** Sleep for the poll interval with jitter, waking early on shutdown. */
  private idle(): Promise<void> {
    const jitter = Math.floor(Math.random() * this.config.pollIntervalMs * 0.2);
    const delay = this.config.pollIntervalMs + jitter;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, delay);
      this.wake = finish;
      function finish() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private async maybeReclaim(): Promise<void> {
    const interval = this.config.leaseDurationMs * RECLAIM_INTERVAL_FACTOR;
    if (Date.now() - this.lastReclaimAt < interval) return;
    this.lastReclaimAt = Date.now();
    const result = await this.store.reclaimExpired();
    if (result.requeued.length > 0 || result.exhausted.length > 0) {
      this.logger.warn("reclaimed jobs from expired leases", {
        requeued: result.requeued.length,
        exhausted: result.exhausted.length
      });
    }
  }

  private spawn(job: JobRecord): void {
    const controller = new AbortController();
    const promise = this.execute(job, controller).finally(() => {
      this.inFlight.delete(job.id);
    });
    this.inFlight.set(job.id, { promise, controller });
  }

  private async execute(job: JobRecord, controller: AbortController): Promise<void> {
    const handler = this.handlers.get(job.type);
    const correlationId = typeof job.payload.correlationId === "string" ? job.payload.correlationId : randomUUID();
    const jobLogger = this.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts, correlationId });

    if (!handler) {
      // Should be impossible (we only claim types we handle) but must never hang.
      await this.store.fail(job.id, this.config.id, {
        code: "WORKER_NO_HANDLER",
        message: `No handler registered for job type "${job.type}"`,
        retryable: false,
        retryDelayMs: 0
      });
      return;
    }

    this.hooks.onJobStarted?.(job);
    jobLogger.info("job started");

    const heartbeat = setInterval(() => {
      void this.beat(job, controller, jobLogger);
    }, this.config.heartbeatIntervalMs);

    const start = Date.now();
    try {
      const result = await handler.handle({
        job,
        logger: jobLogger,
        signal: controller.signal,
        heartbeat: () => this.beat(job, controller, jobLogger)
      });

      if (controller.signal.aborted) {
        jobLogger.warn("job was cancelled after completing its work; result discarded");
        this.hooks.onJobFinished?.(job, "CANCELLED");
        return;
      }

      await this.store.complete(job.id, this.config.id, result ?? null);
      jobLogger.info("job succeeded", { durationMs: Date.now() - start });
      this.hooks.onJobFinished?.(job, "SUCCEEDED");
    } catch (error) {
      const capibaraError = toCapibaraError(error, "JOB");
      const cancelled = controller.signal.aborted;
      const retryDelayMs = computeBackoff(job.attempts);
      // Typed errors declare whether they are worth retrying. An *untyped* error is
      // an unexpected fault, so it is retried (bounded by maxAttempts) rather than
      // discarding the job on the first hiccup.
      const retryable = cancelled || (isCapibaraError(error) ? capibaraError.retryable : true);

      await this.store.fail(job.id, this.config.id, {
        code: capibaraError.code,
        message: capibaraError.message,
        details: capibaraError.details,
        retryable,
        retryDelayMs
      });

      jobLogger.failure("job failed", capibaraError, { durationMs: Date.now() - start, cancelled, retryDelayMs });
      this.hooks.onJobFinished?.(job, cancelled ? "CANCELLED" : "FAILED");
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async beat(job: JobRecord, controller: AbortController, logger: Logger): Promise<void> {
    try {
      const result = await this.store.heartbeat(job.id, this.config.id, this.config.leaseDurationMs);
      if (result === null) {
        logger.warn("lease lost; aborting job to avoid duplicate execution");
        controller.abort();
        return;
      }
      if (result.cancelRequested) {
        logger.info("cancellation requested; aborting job");
        controller.abort();
      }
    } catch (error) {
      logger.failure("heartbeat failed", error);
    }
  }
}

/** Exponential backoff for job retries: 30s, 60s, 120s, … capped at 15 minutes. */
export function computeBackoff(attempt: number): number {
  const base = 30_000;
  const capped = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), 15 * 60_000);
  const jitter = Math.floor(Math.random() * capped * 0.1);
  return capped + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
