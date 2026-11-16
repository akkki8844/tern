import { getLogger, internalMessageOf } from "@tern/shared";
import { disconnectPrisma } from "@tern/db";
import { createRuntime } from "./runtime.js";
import { Worker } from "./worker.js";
import { createAnalysisHandler } from "./handlers/analysis-handler.js";
import { createWebhookHandler } from "./handlers/webhook-handler.js";

/**
 * Worker entrypoint.
 *
 * Startup order matters: configuration is validated first, then logging is
 * configured, then the database connection is verified. A misconfigured or
 * unreachable deployment fails here, loudly, instead of accepting jobs it cannot run.
 */
async function main(): Promise<void> {
  const runtime = await createRuntime();
  const logger = getLogger("worker-main");

  const worker = new Worker({
    store: runtime.jobs,
    config: runtime.config.worker,
    handlers: [
      createWebhookHandler({ prisma: runtime.prisma, jobs: runtime.jobs, audit: runtime.audit }),
      createAnalysisHandler({
        prisma: runtime.prisma,
        audit: runtime.audit,
        config: runtime.config,
        providers: runtime.providers
      })
    ]
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn("second shutdown signal received; exiting immediately", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("shutdown signal received", { signal });
    try {
      // Drain in-flight jobs before the process exits. Anything that cannot finish
      // is returned to the queue by lease expiry, so no work is lost.
      await worker.stop(signal);
      await disconnectPrisma();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error("shutdown failed", { reason: internalMessageOf(error) });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", { reason: internalMessageOf(reason) });
  });
  process.on("uncaughtException", (error) => {
    logger.fatal("uncaught exception; shutting down", { reason: internalMessageOf(error) });
    void shutdown("uncaughtException");
  });

  await worker.start();
}

main().catch((error) => {
  // Configuration and connectivity failures land here, before any logger exists.
  const logger = getLogger("worker-main");
  logger.failure("worker failed to start", error);
  process.exitCode = 1;
});
