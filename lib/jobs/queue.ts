import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = process.env.REDIS_URL ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) : null;
const realQueue = connection ? new Queue("analysis", { connection }) : null;

export const analysisQueue = {
  add: async (name: string, data: Record<string, unknown>) => {
    if (!realQueue) return { id: "demo-job" };
    const job = await realQueue.add(name, data);
    return { id: String(job.id) };
  },
};
