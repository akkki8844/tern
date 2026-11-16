import { PrismaClient } from "@prisma/client";
import { getConfig, getLogger, DatabaseError, internalMessageOf } from "@capibara/shared";

const logger = getLogger("db");

let client: PrismaClient | undefined;

/**
 * Process-wide Prisma client.
 *
 * The connection string comes from the validated configuration; it is never read
 * from `process.env` here and never logged. Query logging is disabled outside of
 * development because query text can contain repository data.
 */
export function getPrisma(): PrismaClient {
  if (client) return client;
  const config = getConfig();
  client = new PrismaClient({
    datasources: { db: { url: config.database.url.reveal() } },
    log: config.nodeEnv === "development" ? [{ emit: "event", level: "warn" }, { emit: "event", level: "error" }] : [{ emit: "event", level: "error" }]
  });

  // Prisma emits its own log events; route them through the redacting logger.
  const emitter = client as unknown as { $on: (event: string, cb: (e: { message?: string }) => void) => void };
  emitter.$on("error", (event) => logger.error("prisma error", { message: event.message }));
  emitter.$on("warn", (event) => logger.warn("prisma warning", { message: event.message }));

  return client;
}

/** Verify the database is reachable. Used by health checks and worker startup. */
export async function checkDatabaseConnection(prisma: PrismaClient = getPrisma()): Promise<void> {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (error) {
    throw new DatabaseError("Database is unreachable", {
      code: "DB_UNREACHABLE",
      retryable: true,
      cause: error,
      details: { reason: internalMessageOf(error) }
    });
  }
}

export async function disconnectPrisma(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.$disconnect();
}

/** Test seam: install a pre-built client (for example one backed by a test database). */
export function setPrismaForTesting(instance: PrismaClient | undefined): void {
  client = instance;
}

export { PrismaClient };
