import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the Prisma migrations directory shipped with this package. */
export const MIGRATIONS_DIR = resolve(here, "..", "prisma", "migrations");

/**
 * Read every migration's SQL in lexical order.
 *
 * Used by the job-store test suite to build a schema in an embedded PostgreSQL
 * instance from exactly the same DDL that production runs, so a migration that is
 * invalid or inconsistent with the code fails in CI rather than in production.
 */
export async function readMigrationSql(): Promise<Array<{ name: string; sql: string }>> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrations: Array<{ name: string; sql: string }> = [];
  for (const name of directories) {
    const sql = await readFile(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
    migrations.push({ name, sql });
  }
  return migrations;
}
