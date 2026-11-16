import { PipelineError, getLogger, toCapibaraError, type Logger, type PipelineStageName, type CapibaraConfig } from "@capibara/shared";
import type { AIProvider, GitHubProvider, RepositoryProvider, Workspace, WorkspaceProvider } from "@capibara/shared";
import type { SandboxRunner } from "@capibara/sandbox";

/**
 * Everything a stage is allowed to touch.
 *
 * Stages receive their dependencies here rather than importing singletons, so the
 * pipeline can run against demo providers, test doubles or production clients
 * without any code changing.
 */
export interface StageContext {
  readonly analysisRunId: string;
  readonly jobId: string;
  /** Correlates every log line, audit record and stage row for one run. */
  readonly correlationId: string;
  readonly logger: Logger;
  readonly config: CapibaraConfig;
  readonly workspace: Workspace;
  readonly providers: {
    github: GitHubProvider;
    ai: AIProvider;
    repository: RepositoryProvider;
    workspaces: WorkspaceProvider;
    sandbox: SandboxRunner;
  };
  /** Aborted when the job is cancelled or the worker is shutting down. */
  readonly signal: AbortSignal;
  /** Renew the job lease and report liveness. Long stages must call this. */
  heartbeat(): Promise<void>;
  /** Persist stage progress. Implementations may be no-ops (demo, tests). */
  recordStage(record: StageRecord): Promise<void>;
}

export interface StageRecord {
  stage: PipelineStageName;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  output?: Record<string, unknown>;
}

export interface Stage<TInput, TOutput> {
  readonly name: PipelineStageName;
  /** Short description used in logs and the PR body. */
  readonly description: string;
  run(input: TInput, context: StageContext): Promise<TOutput>;
  /** Optional projection of the output for persistence/logging. Must be small. */
  summarise?(output: TOutput): Record<string, unknown>;
}

export interface StageOutcome {
  stage: PipelineStageName;
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  summary?: Record<string, unknown>;
}

const logger = getLogger("pipeline");

/**
 * Execute one stage with uniform observability.
 *
 * Responsibilities that belong here and nowhere else:
 *  - timing
 *  - structured start/finish logging with the correlation id
 *  - persistence of the stage row
 *  - translating any thrown value into a typed PipelineError that names the stage
 *  - honouring cancellation before the stage begins
 */
export async function runStage<TInput, TOutput>(
  stage: Stage<TInput, TOutput>,
  input: TInput,
  context: StageContext,
  outcomes: StageOutcome[]
): Promise<TOutput> {
  if (context.signal.aborted) {
    outcomes.push({ stage: stage.name, status: "CANCELLED", durationMs: 0 });
    await context.recordStage({ stage: stage.name, status: "CANCELLED" });
    throw new PipelineError(`Pipeline cancelled before stage ${stage.name}`, {
      code: "PIPELINE_CANCELLED",
      details: { stage: stage.name }
    });
  }

  const stageLogger = context.logger.child({ stage: stage.name });
  const start = Date.now();
  stageLogger.info("stage started", { description: stage.description });
  await context.recordStage({ stage: stage.name, status: "RUNNING" });

  try {
    const output = await stage.run(input, { ...context, logger: stageLogger });
    const durationMs = Date.now() - start;
    const summary = stage.summarise?.(output);
    outcomes.push({ stage: stage.name, status: "SUCCEEDED", durationMs, summary });
    stageLogger.info("stage succeeded", { durationMs, ...summary });
    await context.recordStage({ stage: stage.name, status: "SUCCEEDED", durationMs, output: summary });
    return output;
  } catch (error) {
    const durationMs = Date.now() - start;
    const capibaraError = toCapibaraError(error, "PIPELINE");
    const cancelled = context.signal.aborted || capibaraError.code === "PIPELINE_CANCELLED";
    outcomes.push({
      stage: stage.name,
      status: cancelled ? "CANCELLED" : "FAILED",
      durationMs,
      errorCode: capibaraError.code,
      errorMessage: capibaraError.message
    });
    stageLogger.failure("stage failed", capibaraError, { durationMs });
    await context.recordStage({
      stage: stage.name,
      status: cancelled ? "CANCELLED" : "FAILED",
      durationMs,
      errorCode: capibaraError.code,
      errorMessage: capibaraError.message
    });

    // Failures propagate: the pipeline never continues past a broken stage, and the
    // original error (with its retryable flag) is preserved for the job system.
    throw new PipelineError(`Stage ${stage.name} failed: ${capibaraError.message}`, {
      code: capibaraError.code,
      retryable: capibaraError.retryable,
      cause: capibaraError,
      details: { stage: stage.name, ...capibaraError.details },
      publicMessage: capibaraError.publicMessage
    });
  } finally {
    logger.debug("stage finished", { stage: stage.name, correlationId: context.correlationId });
  }
}
