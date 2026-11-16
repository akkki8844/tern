import { DatabaseError, internalMessageOf } from "@tern/shared";
import type { PrismaClient } from "@prisma/client";

/**
 * Narrow SQL boundary.
 *
 * A handful of operations — notably atomic job claiming with
 * `FOR UPDATE SKIP LOCKED` — have no ORM equivalent and must be expressed as SQL.
 * Rather than scattering `$queryRaw` through the codebase, those operations go
 * through this one interface, which:
 *
 *  - forces parameterised queries (no string interpolation of values anywhere)
 *  - keeps the job store testable against any PostgreSQL, including an embedded one
 *  - gives a single place to translate driver errors into `DatabaseError`
 */
export interface SqlClient {
  /** Run a parameterised query using `$1`-style placeholders and return the rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export function createPrismaSqlClient(prisma: PrismaClient): SqlClient {
  return {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      try {
        const rows: unknown = await prisma.$queryRawUnsafe(sql, ...params);
        return rows as T[];
      } catch (error) {
        throw new DatabaseError("SQL query failed", {
          code: "DB_QUERY_FAILED",
          retryable: isTransient(error),
          cause: error,
          // The statement is safe to record (it never contains values); parameters are not.
          details: { statement: firstLine(sql), reason: internalMessageOf(error) }
        });
      }
    }
  };
}

function firstLine(sql: string): string {
  return sql.trim().split("\n", 1)[0].slice(0, 200);
}

const TRANSIENT_PATTERNS = [
  /connection/i,
  /timeout/i,
  /terminating connection/i,
  /server closed/i,
  /deadlock detected/i,
  /could not serialize/i,
  /too many clients/i
];

export function isTransient(error: unknown): boolean {
  const message = internalMessageOf(error);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}
