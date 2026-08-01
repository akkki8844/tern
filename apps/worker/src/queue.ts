import { getConfig, getLogger, RepositoryRef } from "@tern/shared";
import { AnalysisOrchestrator, AnalysisInput } from "./orchestrator.js";
import { getQueue, PgQueue, JobData } from "./pg-queue.js";
const logger = getLogger("queue");

export interface AnalysisJobData {
  analysisId: string;
  repository: RepositoryRef;
  oldSpecPath: string;
  newSpecPath: string;
  baseCommitSha: string;
  headCommitSha: string;
  repoPath?: string;
}

export class AnalysisQueue {
  private queue: PgQueue;
  private orchestrator: AnalysisOrchestrator;

  constructor() {
    this.queue = getQueue();
    this.orchestrator = new AnalysisOrchestrator();
    
    // Register the analysis processor
    this.queue.register({
      type: "analysis",
      handler: async (job) => this.process(job.data as unknown as AnalysisJobData),
      concurrency: 2,
    });
  }

  async enqueue(data: AnalysisJobData): Promise<string> {
    return this.queue.enqueue({
      type: "analysis",
      data: data as unknown as JobData,
      priority: 1,
    });
  }

  private async process(data: AnalysisJobData): Promise<unknown> {
    logger.info("processing job", { analysisId: data.analysisId });
    const orchestrator = new AnalysisOrchestrator({ repoPath: data.repoPath });
    return orchestrator.run(data as AnalysisInput);
  }

  async start(): Promise<void> {
    await this.queue.start();
    logger.info("analysis queue started");
  }

  async close(): Promise<void> {
    await this.queue.stop();
    logger.info("analysis queue closed");
  }

  async getStats() {
    return this.queue.getStats();
  }
}
