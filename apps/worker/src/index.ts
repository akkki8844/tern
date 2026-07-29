
import { getLogger, getConfig } from "@tern/shared";
import { AnalysisQueue } from "./queue";
const logger = getLogger("worker");
const queue = new AnalysisQueue();
logger.info({ demoMode: getConfig().DEMO_MODE }, "Tern worker started");
process.on("SIGTERM", async () => {
  logger.info("shutting down worker");
  await queue.close();
  process.exit(0);
});
