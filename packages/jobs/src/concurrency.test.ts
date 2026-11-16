import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PostgresJobStore } from "./store.js";
import type { SqlClient } from "@tern/db";

/**
 * True multi-connection concurrency test.
 *
 * PGlite (used by store.test.ts) is a single-backend PostgreSQL, so it cannot prove
 * that `FOR UPDATE SKIP LOCKED` prevents two *simultaneous* workers from claiming the
 * same job. That property needs a real server with several connections, so this suite
 * only runs when TERN_TEST_DATABASE_URL points at one.
 *
 * CI provides a PostgreSQL service container, so this executes on every pipeline run.
 * Locally it is skipped — loudly — rather than silently passing.
 */
const DATABASE_URL = process.env.TERN_TEST_DATABASE_URL;
const CONNECTIONS = 8;
const JOBS = 40;

describe("concurrent claiming against a real PostgreSQL server", { skip: skipReason() }, () => {
  let clients: Array<{ sql: SqlClient; close: () => Promise<void> }> = [];
  let stores: PostgresJobStore[] = [];

  before(async () => {
    clients = await Promise.all(Array.from({ length: CONNECTIONS }, () => connect(DATABASE_URL!)));
    stores = clients.map((client) => new PostgresJobStore(client.sql));
    await clients[0].sql.query('DELETE FROM "Job" WHERE "type" = $1', ["concurrency-test"]);
  });

  after(async () => {
    if (clients.length > 0) {
      await clients[0].sql.query('DELETE FROM "Job" WHERE "type" = $1', ["concurrency-test"]).catch(() => undefined);
      await Promise.all(clients.map((client) => client.close()));
    }
  });

  it("never hands the same job to two workers", async () => {
    for (let i = 0; i < JOBS; i += 1) {
      await stores[0].enqueue({ type: "concurrency-test", payload: { i } });
    }

    const batches = await Promise.all(
      stores.map((store, index) =>
        store.claim({ types: ["concurrency-test"], workerId: `worker-${index}`, leaseDurationMs: 30_000, limit: JOBS })
      )
    );

    const claimedIds = batches.flat().map((job) => job.id);
    const unique = new Set(claimedIds);
    assert.equal(claimedIds.length, JOBS, "every job should be claimed exactly once");
    assert.equal(unique.size, JOBS, "no job may be claimed by more than one worker");
  });

  it("keeps enqueue idempotent under concurrency", async () => {
    const key = `concurrency-idem-${Date.now()}`;
    const results = await Promise.all(
      stores.map((store) => store.enqueue({ type: "concurrency-test", idempotencyKey: key }))
    );
    const ids = new Set(results.map((r) => r.job.id));
    assert.equal(ids.size, 1, "all concurrent enqueues must resolve to a single job");
    assert.equal(results.filter((r) => r.created).length, 1);
  });
});

function skipReason(): string | false {
  if (!DATABASE_URL) {
    return "TERN_TEST_DATABASE_URL is not set: multi-connection concurrency cannot be verified without a real PostgreSQL server";
  }
  return false;
}

async function connect(url: string): Promise<{ sql: SqlClient; close: () => Promise<void> }> {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const { createPrismaSqlClient } = await import("@tern/db");
  return {
    sql: createPrismaSqlClient(prisma),
    close: () => prisma.$disconnect()
  };
}
