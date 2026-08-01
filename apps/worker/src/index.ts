import { getConfig, getLogger } from "@tern/shared";
import { AnalysisQueue } from "./queue.js";

export { AnalysisQueue } from "./queue.js";

const logger = getLogger("worker");
const queue = new AnalysisQueue();

async function main() {
  logger.info("Tern worker started", { demoMode: getConfig().DEMO_MODE });
  await queue.start();
}

main().catch((err) => {
  logger.error("worker failed to start", { err: err.message });
  process.exit(1);
});

process.on("SIGTERM", async () => {
  logger.info("shutting down worker");
  await queue.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("shutting down worker");
  await queue.close();
  process.exit(0);
});
