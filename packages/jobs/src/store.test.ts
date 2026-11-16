import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PostgresJobStore } from "./store.js";
import { createEmbeddedPostgres, type EmbeddedPostgres } from "./testing/embedded-postgres.js";

/**
 * These tests run against a real PostgreSQL engine (PGlite = PostgreSQL 16 compiled
 * to WASM) using the exact DDL from prisma/migrations. Nothing here is mocked.
 */
describe("PostgresJobStore", () => {
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

  describe("enqueue", () => {
    it("creates a PENDING job with the supplied payload", async () => {
      const { job, created } = await store.enqueue({ type: "analysis", payload: { runId: "r1" } });
      assert.equal(created, true);
      assert.equal(job.status, "PENDING");
      assert.equal(job.type, "analysis");
      assert.deepEqual(job.payload, { runId: "r1" });
      assert.equal(job.attempts, 0);
      assert.equal(job.maxAttempts, 3);
      assert.equal(job.lockedBy, null);
    });

    it("is idempotent for a given idempotency key", async () => {
      const first = await store.enqueue({ type: "analysis", idempotencyKey: "push:abc" });
      const second = await store.enqueue({ type: "analysis", idempotencyKey: "push:abc", payload: { other: true } });
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.job.id, first.job.id);
      const stats = await store.stats();
      assert.equal(stats.pending, 1);
    });

    it("allows many jobs without an idempotency key", async () => {
      await store.enqueue({ type: "analysis" });
      await store.enqueue({ type: "analysis" });
      assert.equal((await store.stats()).pending, 2);
    });

    it("rejects an invalid maxAttempts instead of silently clamping", async () => {
      await assert.rejects(() => store.enqueue({ type: "analysis", maxAttempts: 0 }), /maxAttempts/);
    });

    it("honours a delay so the job is not immediately claimable", async () => {
      await store.enqueue({ type: "analysis", delayMs: 60_000 });
      const claimed = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 1000, limit: 5 });
      assert.equal(claimed.length, 0);
    });
  });

  describe("claim", () => {
    it("claims a job exactly once", async () => {
      const { job } = await store.enqueue({ type: "analysis" });

      const first = await store.claim({ types: ["analysis"], workerId: "worker-a", leaseDurationMs: 30_000, limit: 5 });
      const second = await store.claim({ types: ["analysis"], workerId: "worker-b", leaseDurationMs: 30_000, limit: 5 });

      assert.equal(first.length, 1);
      assert.equal(first[0].id, job.id);
      assert.equal(first[0].status, "RUNNING");
      assert.equal(first[0].lockedBy, "worker-a");
      assert.equal(first[0].attempts, 1);
      assert.ok(first[0].leaseExpiresAt instanceof Date);
      assert.equal(second.length, 0, "a second worker must not be able to claim the same job");
    });

    it("does not claim jobs of other types", async () => {
      await store.enqueue({ type: "analysis" });
      const claimed = await store.claim({ types: ["publish"], workerId: "w1", leaseDurationMs: 1000, limit: 5 });
      assert.equal(claimed.length, 0);
    });

    it("respects the limit", async () => {
      for (let i = 0; i < 5; i += 1) await store.enqueue({ type: "analysis" });
      const claimed = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 1000, limit: 2 });
      assert.equal(claimed.length, 2);
    });

    it("claims higher priority first", async () => {
      await store.enqueue({ type: "analysis", payload: { n: "low" }, priority: 0 });
      await store.enqueue({ type: "analysis", payload: { n: "high" }, priority: 10 });
      const claimed = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 1000, limit: 1 });
      assert.equal(claimed[0].payload.n, "high");
    });

    it("never claims a cancelled job", async () => {
      const { job } = await store.enqueue({ type: "analysis" });
      await store.cancel(job.id);
      const claimed = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 1000, limit: 5 });
      assert.equal(claimed.length, 0);
    });
  });

  describe("heartbeat", () => {
    it("extends the lease for the lease holder", async () => {
      await store.enqueue({ type: "analysis" });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 1_000, limit: 1 });
      const before = job.leaseExpiresAt!.getTime();
      await delay(20);
      const result = await store.heartbeat(job.id, "w1", 60_000);
      assert.deepEqual(result, { cancelRequested: false });
      const updated = await store.get(job.id);
      assert.ok(updated!.leaseExpiresAt!.getTime() > before);
    });

    it("returns null for a worker that does not hold the lease", async () => {
      await store.enqueue({ type: "analysis" });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 1_000, limit: 1 });
      assert.equal(await store.heartbeat(job.id, "impostor", 60_000), null);
    });

    it("surfaces a cancellation request to the running worker", async () => {
      await store.enqueue({ type: "analysis" });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });
      await store.cancel(job.id);
      const result = await store.heartbeat(job.id, "w1", 60_000);
      assert.deepEqual(result, { cancelRequested: true });
      // A RUNNING job is not force-killed; it stays RUNNING until the worker yields.
      assert.equal((await store.get(job.id))!.status, "RUNNING");
    });
  });

  describe("complete", () => {
    it("marks the job SUCCEEDED and stores the result", async () => {
      await store.enqueue({ type: "analysis" });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });
      const done = await store.complete(job.id, "w1", { patches: 3 });
      assert.equal(done!.status, "SUCCEEDED");
      assert.deepEqual(done!.result, { patches: 3 });
      assert.equal(done!.lockedBy, null);
      assert.ok(done!.completedAt instanceof Date);
    });

    it("refuses completion from a worker that lost the lease", async () => {
      await store.enqueue({ type: "analysis" });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });
      assert.equal(await store.complete(job.id, "other", { ok: true }), null);
      assert.equal((await store.get(job.id))!.status, "RUNNING");
    });
  });

  describe("fail and retry", () => {
    it("returns a retryable job to PENDING with a backoff", async () => {
      await store.enqueue({ type: "analysis", maxAttempts: 3 });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });

      const failed = await store.fail(job.id, "w1", {
        code: "GITHUB_ERROR",
        message: "502 from GitHub",
        retryable: true,
        retryDelayMs: 60_000
      });

      assert.equal(failed!.status, "PENDING");
      assert.equal(failed!.attempts, 1);
      assert.equal(failed!.errorCode, "GITHUB_ERROR");
      assert.ok(failed!.availableAt.getTime() > Date.now() + 30_000, "backoff must delay the next attempt");
      const claimed = await store.claim({ types: ["analysis"], workerId: "w2", leaseDurationMs: 1000, limit: 1 });
      assert.equal(claimed.length, 0, "job must not be claimable before the backoff elapses");
    });

    it("moves to FAILED once attempts are exhausted", async () => {
      await store.enqueue({ type: "analysis", maxAttempts: 2 });

      const [first] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });
      await store.fail(first.id, "w1", { code: "E", message: "boom", retryable: true, retryDelayMs: 0 });

      const [second] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });
      assert.equal(second.attempts, 2);
      const failed = await store.fail(second.id, "w1", { code: "E", message: "boom", retryable: true, retryDelayMs: 0 });

      assert.equal(failed!.status, "FAILED");
      assert.equal((await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 1000, limit: 1 })).length, 0);
    });

    it("fails immediately for a non-retryable error even with attempts left", async () => {
      await store.enqueue({ type: "analysis", maxAttempts: 5 });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });
      const failed = await store.fail(job.id, "w1", {
        code: "CONFIGURATION_ERROR",
        message: "GitHub App is not configured",
        retryable: false,
        retryDelayMs: 60_000
      });
      assert.equal(failed!.status, "FAILED");
      assert.equal(failed!.attempts, 1);
    });

    it("redacts secrets in stored error details", async () => {
      await store.enqueue({ type: "analysis" });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });
      await store.fail(job.id, "w1", {
        code: "GITHUB_ERROR",
        message: "request failed",
        details: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        retryable: false,
        retryDelayMs: 0
      });
      const rows = await pg.sql.query<{ errorDetails: unknown }>(`SELECT "errorDetails" FROM "Job" WHERE "id" = $1`, [
        job.id
      ]);
      assert.ok(!JSON.stringify(rows[0].errorDetails).includes("ghp_"));
    });
  });

  describe("stale job recovery", () => {
    it("requeues a job whose lease expired (crashed worker)", async () => {
      await store.enqueue({ type: "analysis", maxAttempts: 3 });
      const [job] = await store.claim({ types: ["analysis"], workerId: "crashed-worker", leaseDurationMs: 50, limit: 1 });
      assert.equal(job.status, "RUNNING");

      // Simulate the worker dying: no heartbeat, no completion.
      await delay(120);

      const result = await store.reclaimExpired();
      assert.deepEqual(result.requeued, [job.id]);
      assert.deepEqual(result.exhausted, []);

      const recovered = await store.get(job.id);
      assert.equal(recovered!.status, "PENDING");
      assert.equal(recovered!.lockedBy, null);
      assert.equal(recovered!.errorCode, "JOB_LEASE_EXPIRED");

      const reclaimed = await store.claim({ types: ["analysis"], workerId: "worker-b", leaseDurationMs: 60_000, limit: 1 });
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0].attempts, 2, "the recovered attempt must be counted");
    });

    it("fails a stale job that has no attempts left", async () => {
      await store.enqueue({ type: "analysis", maxAttempts: 1 });
      const [job] = await store.claim({ types: ["analysis"], workerId: "crashed", leaseDurationMs: 50, limit: 1 });
      await delay(120);
      const result = await store.reclaimExpired();
      assert.deepEqual(result.exhausted, [job.id]);
      assert.equal((await store.get(job.id))!.status, "FAILED");
    });

    it("leaves a heartbeating job alone", async () => {
      await store.enqueue({ type: "analysis" });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60, limit: 1 });
      await delay(40);
      await store.heartbeat(job.id, "w1", 60_000);
      await delay(60);
      const result = await store.reclaimExpired();
      assert.deepEqual(result.requeued, []);
      assert.equal((await store.get(job.id))!.status, "RUNNING");
    });
  });

  describe("cancel", () => {
    it("cancels a pending job immediately", async () => {
      const { job } = await store.enqueue({ type: "analysis" });
      const cancelled = await store.cancel(job.id);
      assert.equal(cancelled!.status, "CANCELLED");
      assert.ok(cancelled!.completedAt instanceof Date);
    });

    it("returns null for an unknown or terminal job", async () => {
      assert.equal(await store.cancel("does-not-exist"), null);
      const { job } = await store.enqueue({ type: "analysis" });
      await store.cancel(job.id);
      assert.equal(await store.cancel(job.id), null);
    });
  });

  describe("stats and purge", () => {
    it("counts jobs by status", async () => {
      await store.enqueue({ type: "analysis" });
      const { job } = await store.enqueue({ type: "analysis" });
      await store.cancel(job.id);
      const stats = await store.stats();
      assert.equal(stats.pending, 1);
      assert.equal(stats.cancelled, 1);
    });

    it("purges terminal jobs older than the cutoff and keeps failures", async () => {
      await store.enqueue({ type: "analysis" });
      const [job] = await store.claim({ types: ["analysis"], workerId: "w1", leaseDurationMs: 60_000, limit: 1 });
      await store.complete(job.id, "w1", null);

      assert.equal(await store.purgeTerminal(60_000), 0, "recent jobs must be kept");
      assert.equal(await store.purgeTerminal(0), 1);
      assert.equal(await store.get(job.id), null);
    });
  });
});
