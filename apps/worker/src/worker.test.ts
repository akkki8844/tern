import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PostgresJobStore, createEmbeddedPostgres, type EmbeddedPostgres, type JobRecord } from "@tern/jobs";
import { createTestLogger, type WorkerConfig } from "@tern/shared";
import { Worker, computeBackoff, type JobContext, type JobHandler } from "./worker.js";

/**
 * Worker tests run against a real PostgreSQL engine and the real job store; only the
 * job *handlers* are test doubles, because the handler body is the thing under test's
 * control, not its collaborator.
 */
const baseConfig: WorkerConfig = {
  id: "worker-test",
  concurrency: 2,
  pollIntervalMs: 20,
  leaseDurationMs: 400,
  heartbeatIntervalMs: 50,
  shutdownTimeoutMs: 1_000
};

function handler(type: string, fn: (context: JobContext) => Promise<unknown>): JobHandler {
  return { type, handle: fn };
}

describe("Worker", () => {
  let pg: EmbeddedPostgres;
  let store: PostgresJobStore;

  before(async () => {
    pg = await createEmbeddedPostgres();
    store = new PostgresJobStore(pg.sql);
  });

  after(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.reset();
  });

  it("refuses to start without handlers or with duplicates", () => {
    assert.throws(() => new Worker({ store, handlers: [], config: baseConfig }), /at least one job handler/);
    assert.throws(
      () =>
        new Worker({
          store,
          handlers: [handler("a", async () => undefined), handler("a", async () => undefined)],
          config: baseConfig
        }),
      /Duplicate handler/
    );
  });

  it("claims and completes a job, storing the handler result", async () => {
    await store.enqueue({ type: "analysis", payload: { runId: "r1" } });
    const worker = new Worker({
      store,
      handlers: [handler("analysis", async (context) => ({ seen: context.job.payload.runId }))],
      config: baseConfig,
      logger: createTestLogger().logger
    });

    await worker.tick();
    await worker.drain();

    const stats = await store.stats();
    assert.equal(stats.succeeded, 1);
    assert.equal(stats.pending, 0);
  });

  it("never runs the same job twice, even with two workers polling", async () => {
    await store.enqueue({ type: "analysis" });

    const executions: string[] = [];
    const make = (id: string) =>
      new Worker({
        store,
        handlers: [
          handler("analysis", async (context) => {
            executions.push(`${id}:${context.job.id}`);
            await delay(30);
          })
        ],
        config: { ...baseConfig, id },
        logger: createTestLogger().logger
      });

    const a = make("worker-a");
    const b = make("worker-b");
    await Promise.all([a.tick(), b.tick()]);
    await Promise.all([a.drain(), b.drain()]);

    assert.equal(executions.length, 1, `job executed ${executions.length} times: ${executions.join(", ")}`);
  });

  it("respects the concurrency limit", async () => {
    for (let i = 0; i < 5; i += 1) await store.enqueue({ type: "analysis" });

    let concurrent = 0;
    let peak = 0;
    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await delay(40);
          concurrent -= 1;
        })
      ],
      config: { ...baseConfig, concurrency: 2 },
      logger: createTestLogger().logger
    });

    await worker.tick();
    await worker.drain();
    assert.ok(peak <= 2, `peak concurrency was ${peak}`);
  });

  it("marks a failing job for retry with a backoff and retries it", async () => {
    await store.enqueue({ type: "analysis", maxAttempts: 3 });
    let attempts = 0;
    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient failure");
          return { ok: true };
        })
      ],
      config: baseConfig,
      logger: createTestLogger().logger
    });

    await worker.tick();
    await worker.drain();

    const afterFirst = await store.stats();
    assert.equal(afterFirst.pending, 1, "the job must be queued for another attempt");
    assert.equal(afterFirst.failed, 0);

    // The retry is scheduled with a backoff, so it is not immediately claimable.
    assert.equal(await worker.tick(), 0);
  });

  it("does not retry a non-retryable failure", async () => {
    await store.enqueue({ type: "analysis", maxAttempts: 5 });
    const { ConfigurationError } = await import("@tern/shared");
    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async () => {
          throw new ConfigurationError("GitHub App is not configured");
        })
      ],
      config: baseConfig,
      logger: createTestLogger().logger
    });

    await worker.tick();
    await worker.drain();
    assert.equal((await store.stats()).failed, 1);
  });

  it("recovers jobs abandoned by a crashed worker on startup", async () => {
    await store.enqueue({ type: "analysis" });
    // Simulate a crash: claim with a short lease and never complete.
    await store.claim({ types: ["analysis"], workerId: "crashed", leaseDurationMs: 50, limit: 1 });
    await delay(120);

    const executed: string[] = [];
    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async (context) => {
          executed.push(context.job.id);
        })
      ],
      config: baseConfig,
      logger: createTestLogger().logger
    });

    await worker.start();
    try {
      await waitFor(() => executed.length === 1, 3_000);
    } finally {
      await worker.stop("test");
    }
    assert.equal(executed.length, 1);
  });

  it("aborts a running job when its lease is stolen, so work is never duplicated", async () => {
    await store.enqueue({ type: "analysis", maxAttempts: 2 });
    let aborted = false;

    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async (context) => {
          // Another worker reclaims the job while this one is still working.
          await pg.sql.query('UPDATE "Job" SET "lockedBy" = $1 WHERE "id" = $2', ["thief", context.job.id]);
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
            setTimeout(resolve, 1_500);
          });
        })
      ],
      config: baseConfig,
      logger: createTestLogger().logger
    });

    await worker.tick();
    await worker.drain();
    assert.equal(aborted, true, "the handler must observe the abort when the lease is lost");
  });

  it("aborts a running job when cancellation is requested", async () => {
    const { job } = await store.enqueue({ type: "analysis" });
    let observed = false;

    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async (context) => {
          await store.cancel(context.job.id);
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => {
              observed = true;
              resolve();
            });
            setTimeout(resolve, 1_500);
          });
        })
      ],
      config: baseConfig,
      logger: createTestLogger().logger
    });

    await worker.tick();
    await worker.drain();
    assert.equal(observed, true);
    assert.equal((await store.get(job.id))!.cancelRequested, true);
  });

  it("keeps a long job alive by renewing its lease", async () => {
    await store.enqueue({ type: "analysis" });
    let reclaimedDuringRun = 0;

    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async () => {
          // Runs for longer than the lease; heartbeats must keep it alive.
          for (let i = 0; i < 8; i += 1) {
            await delay(80);
            const result = await store.reclaimExpired();
            reclaimedDuringRun += result.requeued.length + result.exhausted.length;
          }
        })
      ],
      config: baseConfig,
      logger: createTestLogger().logger
    });

    await worker.tick();
    await worker.drain();
    assert.equal(reclaimedDuringRun, 0, "a heartbeating job must never be reclaimed");
    assert.equal((await store.stats()).succeeded, 1);
  });

  it("waits for in-flight jobs during graceful shutdown", async () => {
    await store.enqueue({ type: "analysis" });
    let finished = false;

    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async () => {
          await delay(200);
          finished = true;
        })
      ],
      config: { ...baseConfig, shutdownTimeoutMs: 2_000 },
      logger: createTestLogger().logger
    });

    await worker.start();
    await waitFor(() => worker.inFlightCount === 1, 2_000);
    await worker.stop("SIGTERM");

    assert.equal(finished, true, "shutdown must not interrupt a job that can still finish");
    assert.equal((await store.stats()).succeeded, 1);
    assert.equal(worker.isRunning, false);
  });

  it("cancels in-flight jobs that exceed the shutdown grace period and requeues them", async () => {
    await store.enqueue({ type: "analysis", maxAttempts: 3 });

    const worker = new Worker({
      store,
      handlers: [
        handler("analysis", async (context) => {
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve());
            setTimeout(resolve, 5_000);
          });
          throw new Error("interrupted");
        })
      ],
      config: { ...baseConfig, shutdownTimeoutMs: 150 },
      logger: createTestLogger().logger
    });

    await worker.start();
    await waitFor(() => worker.inFlightCount === 1, 2_000);
    await worker.stop("SIGTERM");

    const stats = await store.stats();
    assert.equal(stats.pending, 1, "an interrupted job must go back to the queue, not be lost");
  });

  it("stops claiming new work once shutdown has begun", async () => {
    const worker = new Worker({
      store,
      handlers: [handler("analysis", async () => undefined)],
      config: baseConfig,
      logger: createTestLogger().logger
    });
    await worker.start();
    await worker.stop("test");

    await store.enqueue({ type: "analysis" });
    await delay(80);
    assert.equal((await store.stats()).pending, 1);
  });

  it("survives a transient store failure without dying", async () => {
    let fail = true;
    const flaky = {
      ...store,
      claim: async (...args: Parameters<PostgresJobStore["claim"]>): Promise<JobRecord[]> => {
        if (fail) {
          fail = false;
          throw new Error("connection reset");
        }
        return store.claim(...args);
      },
      reclaimExpired: () => store.reclaimExpired(),
      heartbeat: (...args: Parameters<PostgresJobStore["heartbeat"]>) => store.heartbeat(...args),
      complete: (...args: Parameters<PostgresJobStore["complete"]>) => store.complete(...args),
      fail: (...args: Parameters<PostgresJobStore["fail"]>) => store.fail(...args)
    } as unknown as PostgresJobStore;

    const worker = new Worker({
      store: flaky,
      handlers: [handler("analysis", async () => undefined)],
      config: baseConfig,
      logger: createTestLogger().logger
    });

    await store.enqueue({ type: "analysis" });
    await worker.start();
    try {
      await waitFor(async () => (await store.stats()).succeeded === 1, 3_000);
    } finally {
      await worker.stop("test");
    }
    assert.equal((await store.stats()).succeeded, 1);
  });
});

describe("computeBackoff", () => {
  it("grows exponentially and stays capped", () => {
    assert.ok(computeBackoff(1) >= 30_000 && computeBackoff(1) < 34_000);
    assert.ok(computeBackoff(2) >= 60_000 && computeBackoff(2) < 67_000);
    assert.ok(computeBackoff(20) <= 15 * 60_000 * 1.1);
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("condition was not met before the timeout");
}
