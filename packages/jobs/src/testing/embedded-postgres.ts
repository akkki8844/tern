import type { PGlite } from "@electric-sql/pglite";
import { readMigrationSql, type SqlClient } from "@tern/db";

/**
 * Test-only PostgreSQL.
 *
 * PGlite is a real PostgreSQL 16 build (compiled to WebAssembly), so the SQL these
 * tests execute — including `FOR UPDATE SKIP LOCKED`, enum casts, `make_interval`
 * and `ON CONFLICT` — is parsed and executed by PostgreSQL itself, not by a mock.
 *
 * Limitation: PGlite exposes a single backend, so it cannot exercise *simultaneous*
 * connections. The multi-connection concurrency test lives in
 * `concurrency.test.ts` and runs against a real server when TERN_TEST_DATABASE_URL
 * is set (CI provides one).
 */
export interface EmbeddedPostgres {
  sql: SqlClient;
  raw: PGlite;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createEmbeddedPostgres(): Promise<EmbeddedPostgres> {
  // Imported dynamically so the embedded engine is only loaded by tests that ask for it.
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create();
  const migrations = await readMigrationSql();
  for (const migration of migrations) {
    await db.exec(migration.sql);
  }

  const sql: SqlClient = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const result = await db.query<T>(text, params as unknown[]);
      return result.rows;
    }
  };

  return {
    sql,
    raw: db,
    async reset() {
      await db.exec('TRUNCATE "Job", "WebhookEvent", "AuditLog" CASCADE;');
    },
    async close() {
      await db.close();
    }
  };
}
