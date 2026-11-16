
import { describe, it, after } from "node:test";
import assert from "node:assert";
import { readMigrationSql } from "@capibara/db";
import pg from "pg";

/**
 * Live-PostgreSQL verification of the shipped migration SQL.
 *
 * The schema-level tests in @capibara/db check the SQL statically and the job-store
 * tests run against PGlite (a single-backend PostgreSQL/WASM build). What only a
 * real server can prove is that the full migration sequence applies cleanly to a
 * genuine PostgreSQL with multiple backends, and that the queue's atomic-claim
 * pattern behaves there. CI provides a PostgreSQL service container and sets
 * CAPIBARA_TEST_DATABASE_URL; without it this suite skips — loudly, never silently.
 */
const DATABASE_URL = process.env.CAPIBARA_TEST_DATABASE_URL;

function skipReason(): string | false {
  if (!DATABASE_URL) {
    return "CAPIBARA_TEST_DATABASE_URL is not set: applying migrations and verifying the claim pattern needs a real PostgreSQL server";
  }
  return false;
}

describe("live PostgreSQL: migrations and queue primitives", { skip: skipReason() }, () => {
  // A dedicated scratch database, created and dropped by this suite, so the
  // target database pointed at by CAPIBARA_TEST_DATABASE_URL is never touched.
  const scratchName = `capibara_migration_verify_${Date.now().toString(36)}`;
  let admin: pg.Client;
  let scratch: pg.Client | undefined;

  after(async () => {
    if (scratch) await scratch.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it("applies every migration in order to a fresh database", async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratchName}"`);

    // Swap the database component of the URL rather than appending, so the
    // suite works whether CAPIBARA_TEST_DATABASE_URL names a database or not.
    const scratchUrl = new URL(DATABASE_URL!);
    scratchUrl.pathname = `/${scratchName}`;
    scratch = new pg.Client({ connectionString: scratchUrl.toString() });
    await scratch.connect();

    const migrations = await readMigrationSql();
    assert.ok(migrations.length >= 1, "the repository must ship at least one migration");

    for (const migration of migrations) {
      // One transaction per migration, exactly like prisma migrate deploy.
      await scratch.query("BEGIN");
      try {
        await scratch.query(migration.sql);
        await scratch.query("COMMIT");
      } catch (error) {
        await scratch.query("ROLLBACK");
        assert.fail(`migration ${migration.name} failed on a real PostgreSQL: ${(error as Error).message}`);
      }
    }

    const tables = await scratch.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const present = new Set(tables.rows.map((row) => row.tablename as string));
    for (const table of ["User", "Session", "Installation", "Repository", "OpenApiSpec", "AnalysisRun", "StageRun", "BreakingChange", "AffectedUsage", "Migration", "Patch", "ValidationResult", "SandboxRun", "PullRequest", "Job", "WebhookEvent", "AuditLog"]) {
      assert.ok(present.has(table), `table ${table} missing after applying migrations`);
    }
  });

  it("claims jobs atomically and recovers expired leases", async () => {
    assert.ok(scratch);
    // createdAt/updatedAt are supplied explicitly: @updatedAt is a Prisma-client
    // default, and this suite intentionally drives raw SQL like the store does.
    await scratch.query(
      `INSERT INTO "Job" (id, type, status, priority, attempts, "maxAttempts", payload, "idempotencyKey", "createdAt", "updatedAt", "availableAt")
       VALUES ('migration-verify-1', 'ANALYSIS', 'PENDING', 0, 0, 3, '{}'::jsonb, 'migration-verify-1', now(), now(), now())`
    );

    const claim = await scratch.query(
      `UPDATE "Job" SET status = 'RUNNING', "lockedBy" = 'verify', "lockedAt" = now(),
             "leaseExpiresAt" = now() + interval '60 seconds', "startedAt" = now()
       WHERE id = (
         SELECT id FROM "Job"
         WHERE status = 'PENDING' AND "availableAt" <= now()
         ORDER BY priority DESC, "createdAt" LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`
    );
    assert.strictEqual(claim.rows[0]?.id, "migration-verify-1", "the pending job was not claimed");

    // A second claim with nothing pending must return nothing.
    const empty = await scratch.query(
      `UPDATE "Job" SET status = 'RUNNING'
       WHERE id = (
         SELECT id FROM "Job" WHERE status = 'PENDING' AND "availableAt" <= now()
         ORDER BY priority DESC, "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id`
    );
    assert.strictEqual(empty.rowCount, 0, "claimed a job out of thin air");

    // Expired lease becomes recoverable.
    await scratch.query(`UPDATE "Job" SET "leaseExpiresAt" = now() - interval '5 seconds' WHERE id = 'migration-verify-1'`);
    const expired = await scratch.query(
      `SELECT id FROM "Job" WHERE status = 'RUNNING' AND "leaseExpiresAt" < now() FOR UPDATE SKIP LOCKED`
    );
    assert.strictEqual(expired.rowCount, 1, "an expired lease was not recoverable");

    await scratch.query(`DELETE FROM "Job" WHERE id = 'migration-verify-1'`);
  });
});

// Keep the import shape honest for the linter when the suite is skipped.
void after;
