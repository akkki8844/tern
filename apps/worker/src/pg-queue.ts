import { prisma } from "@tern/db";
import { getLogger } from "@tern/shared";
const logger = getLogger("pg-queue");

export interface JobData {
  [key: string]: unknown;
}

export interface JobResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface EnqueueOptions {
  type: string;
  data: JobData;
  priority?: number;
  maxAttempts?: number;
  runAt?: Date;
}

export interface ProcessOptions {
  type: string;
  handler: (job: { id: string; data: JobData }) => Promise<unknown>;
  concurrency?: number;
}

export class PgQueue {
  private processors = new Map<string, ProcessOptions>();
  private running = new Map<string, Promise<void>>();
  private polling = false;
  private pollInterval: NodeJS.Timeout | null = null;

  async enqueue(options: EnqueueOptions): Promise<string> {
    const job = await prisma.job.create({
      data: {
        type: options.type,
        data: options.data as any,
        priority: options.priority ?? 0,
        maxAttempts: options.maxAttempts ?? 3,
        runAt: options.runAt ?? new Date(),
      },
    });
    logger.info("job enqueued", { jobId: job.id, type: options.type });
    return job.id;
  }

  register(options: ProcessOptions): void {
    this.processors.set(options.type, options);
    logger.info("processor registered", { type: options.type });
  }

  async start(pollIntervalMs = 1000): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.pollInterval = setInterval(() => this.poll(), pollIntervalMs);
    logger.info("queue started", { pollInterval: pollIntervalMs });
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    // Wait for running jobs to complete
    await Promise.all(this.running.values());
    logger.info("queue stopped");
  }

  private async poll(): Promise<void> {
    try {
      // Find pending jobs that are ready to run
      const jobs = await prisma.job.findMany({
        where: {
          status: "pending",
          runAt: { lte: new Date() },
        },
        orderBy: [
          { priority: "desc" },
          { runAt: "asc" },
        ],
        take: 10,
      });

      for (const job of jobs) {
        const processor = this.processors.get(job.type);
        if (!processor) {
          logger.warn("no processor for job type", { type: job.type, jobId: job.id });
          continue;
        }

        // Check concurrency
        const concurrency = processor.concurrency ?? 1;
        const runningCount = Array.from(this.running.keys())
          .filter(key => key.startsWith(`${job.type}:`)).length;
        
        if (runningCount >= concurrency) {
          continue;
        }

        // Claim the job atomically
        const claimed = await prisma.job.updateMany({
          where: {
            id: job.id,
            status: "pending",
          },
          data: {
            status: "running",
            startedAt: new Date(),
            attempts: { increment: 1 },
          },
        });

        if (claimed.count === 0) {
          continue; // Job was claimed by another worker
        }

        // Process the job
        const key = `${job.type}:${job.id}`;
        const promise = this.processJob(job, processor).finally(() => {
          this.running.delete(key);
        });
        this.running.set(key, promise);
      }
    } catch (err) {
      logger.error("poll error", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private async processJob(
    job: { id: string; type: string; data: unknown; attempts: number; maxAttempts: number },
    processor: ProcessOptions
  ): Promise<void> {
    try {
      logger.info("processing job", { jobId: job.id, type: job.type });
      const result = await processor.handler({
        id: job.id,
        data: job.data as JobData,
      });

      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "completed",
          result: result as any,
          completedAt: new Date(),
        },
      });

      logger.info("job completed", { jobId: job.id });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error("job failed", { jobId: job.id, error });

      const shouldRetry = job.attempts < job.maxAttempts;
      
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: shouldRetry ? "pending" : "failed",
          error,
          failedAt: shouldRetry ? null : new Date(),
          // Exponential backoff for retries
          runAt: shouldRetry
            ? new Date(Date.now() + Math.pow(2, job.attempts) * 1000)
            : undefined,
        },
      });

      if (shouldRetry) {
        logger.info("job scheduled for retry", { jobId: job.id, attempts: job.attempts });
      }
    }
  }

  async getJob(id: string) {
    return prisma.job.findUnique({ where: { id } });
  }

  async getJobsByType(type: string, status?: string) {
    return prisma.job.findMany({
      where: {
        type,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getStats() {
    const [pending, running, completed, failed] = await Promise.all([
      prisma.job.count({ where: { status: "pending" } }),
      prisma.job.count({ where: { status: "running" } }),
      prisma.job.count({ where: { status: "completed" } }),
      prisma.job.count({ where: { status: "failed" } }),
    ]);
    return { pending, running, completed, failed };
  }
}

// Singleton instance
let queue: PgQueue | null = null;

export function getQueue(): PgQueue {
  if (!queue) {
    queue = new PgQueue();
  }
  return queue;
}
