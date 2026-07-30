
import { getLogger, getConfig } from "@tern/shared";
import { AnalysisQueue } from "./queue";
const logger = getLogger("worker");
const queue = new AnalysisQueue();
logger.info("Tern worker started", { demoMode: getConfig().DEMO_MODE });
process.on("SIGTERM", async () => {
  logger.info("shutting down worker");
  await queue.close();
  process.exit(0);
});
