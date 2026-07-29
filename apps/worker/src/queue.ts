
import { Queue, Worker, Job } from "bullmq";
import { getConfig, getLogger, RepositoryRef } from "@tern/shared";
import { AnalysisOrchestrator, AnalysisInput } from "./orchestrator";
const logger = getLogger("queue");

export interface AnalysisJobData {
  analysisId: string;
  repository: RepositoryRef;
  oldSpecPath: string;
  newSpecPath: string;
  baseCommitSha: string;
  headCommitSha: string;
}

export class AnalysisQueue {
  private queue: Queue<AnalysisJobData, any, string>;
  private worker: Worker<AnalysisJobData, any, string>;
  private orchestrator: AnalysisOrchestrator;

  constructor() {
    const cfg = getConfig();
    this.queue = new Queue<AnalysisJobData>("analysis", { connection: { url: cfg.REDIS_URL } });
    this.orchestrator = new AnalysisOrchestrator();
    this.worker = new Worker<AnalysisJobData>("analysis", async (job) => this.process(job), {
      connection: { url: cfg.REDIS_URL },
      concurrency: 2,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 }
    });
    this.worker.on("failed", (job, err) => { logger.error({ jobId: job?.id, err: err.message }, "job failed"); });
  }

  async enqueue(data: AnalysisJobData): Promise<Job<AnalysisJobData>> {
    return this.queue.add("analyze", data, { jobId: data.analysisId });
  }

  private async process(job: Job<AnalysisJobData>): Promise<unknown> {
    logger.info({ jobId: job.id }, "processing job");
    return this.orchestrator.run(job.data as AnalysisInput);
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}
