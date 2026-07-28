import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@/packages/shared/src/env";

export type QueueJobResult = { id: string };

export type AnalysisQueue = {
  add: (name: string, data: Record<string, unknown>) => Promise<QueueJobResult>;
};

function createRealQueue(redisUrl: string): AnalysisQueue {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("analysis", { connection });

  return {
    async add(name, data) {
      const job = await queue.add(name, data);
      return { id: String(job.id) };
    },
  };
}

function createDemoQueue(): AnalysisQueue {
  return {
    async add() {
      return { id: "demo-job" };
    },
  };
}

const env = getEnv();
export const analysisQueue: AnalysisQueue = env.REDIS_URL ? createRealQueue(env.REDIS_URL) : createDemoQueue();
