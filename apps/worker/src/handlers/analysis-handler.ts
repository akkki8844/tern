import { randomUUID } from "node:crypto";
import { JobError, ValidationError, sha256Hex, type CapibaraConfig } from "@capibara/shared";
import type { AuditLogger, PrismaClient } from "@capibara/db";
import type { AIProvider, GitHubProvider, RepositoryProvider, WorkspaceProvider } from "@capibara/shared";
import type { SandboxRunner } from "@capibara/sandbox";
import { withWorkspace } from "@capibara/workspace";
import {
  changeFingerprint,
  runAnalysisPipeline,
  type AnalysisInput,
  type StageContext,
  type StageRecord
} from "@capibara/pipeline";
import { JOB_TYPES, type AnalysisJobPayload } from "../job-types.js";
import type { JobContext, JobHandler } from "../worker.js";

export interface AnalysisHandlerDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  config: CapibaraConfig;
  providers: {
    github: GitHubProvider;
    ai: AIProvider;
    repository: RepositoryProvider;
    workspaces: WorkspaceProvider;
    sandbox: SandboxRunner;
  };
}

/**
 * Run the analysis pipeline for one AnalysisRun and persist everything it produced.
 *
 * The handler owns durability; the pipeline owns the work. Every exit path — success,
 * failure, cancellation — updates the run row and disposes the workspace.
 */
export function createAnalysisHandler(deps: AnalysisHandlerDeps): JobHandler {
  return {
    type: JOB_TYPES.ANALYSIS,

    async handle(context: JobContext) {
      const payload = context.job.payload as unknown as AnalysisJobPayload;
      if (typeof payload.analysisRunId !== "string") {
        throw new ValidationError("Analysis job payload is missing analysisRunId", { code: "JOB_PAYLOAD_INVALID" });
      }

      const run = await deps.prisma.analysisRun.findUnique({
        where: { id: payload.analysisRunId },
        include: { repository: { include: { installation: true } } }
      });
      if (!run) {
        throw new JobError("Analysis run no longer exists", { code: "ANALYSIS_RUN_MISSING", retryable: false });
      }

      const correlationId = payload.correlationId ?? randomUUID();
      const logger = context.logger.child({ analysisRunId: run.id, correlationId });

      await deps.prisma.analysisRun.update({
        where: { id: run.id },
        data: { status: "RUNNING", startedAt: new Date(), errorCode: null, errorMessage: null }
      });

      const input: AnalysisInput = {
        repository: {
          id: run.repository.id,
          githubId: run.repository.githubId,
          owner: run.repository.owner,
          name: run.repository.name,
          defaultBranch: run.repository.defaultBranch,
          installationId: run.repository.installation.githubId
        },
        baseRef: run.baseCommitSha,
        headRef: run.headCommitSha
      };

      const result = await withWorkspace(deps.providers.workspaces, `run-${run.id}`, async (workspace) => {
        const stageContext: StageContext = {
          analysisRunId: run.id,
          jobId: context.job.id,
          correlationId,
          logger,
          config: deps.config,
          workspace,
          providers: deps.providers,
          signal: context.signal,
          heartbeat: () => context.heartbeat(),
          recordStage: (record: StageRecord) => persistStage(deps.prisma, run.id, record)
        };

        return runAnalysisPipeline(input, stageContext, {
          // Publishing requires a provider that can actually write to GitHub.
          publish: deps.providers.github.isReal
        });
      });

      await persistOutcome(deps, run.id, result, correlationId);

      if (result.status === "FAILED") {
        throw new JobError(result.error?.message ?? "Pipeline failed", {
          code: result.error?.code ?? "PIPELINE_FAILED",
          retryable: true,
          details: { stage: result.error?.stage }
        });
      }
      if (result.status === "CANCELLED") {
        throw new JobError("Pipeline cancelled", { code: "PIPELINE_CANCELLED", retryable: true });
      }

      return {
        status: result.status,
        durationMs: result.totalDurationMs,
        stages: result.stages.map((stage) => ({ stage: stage.stage, status: stage.status, durationMs: stage.durationMs })),
        pullRequest: result.publish?.pullRequest?.number ?? null,
        skippedReason: result.publish?.skippedReason
      };
    }
  };
}

async function persistStage(prisma: PrismaClient, analysisRunId: string, record: StageRecord): Promise<void> {
  if (record.status === "RUNNING") {
    await prisma.analysisRun.update({ where: { id: analysisRunId }, data: { currentStage: record.stage } });
    return;
  }
  await prisma.stageRun.upsert({
    where: { analysisRunId_stage_attempt: { analysisRunId, stage: record.stage, attempt: 1 } },
    create: {
      analysisRunId,
      stage: record.stage,
      attempt: 1,
      status: record.status,
      startedAt: new Date(Date.now() - (record.durationMs ?? 0)),
      completedAt: new Date(),
      durationMs: record.durationMs ?? 0,
      errorCode: record.errorCode ?? null,
      errorMessage: record.errorMessage ?? null,
      output: (record.output ?? {}) as never
    },
    update: {
      status: record.status,
      completedAt: new Date(),
      durationMs: record.durationMs ?? 0,
      errorCode: record.errorCode ?? null,
      errorMessage: record.errorMessage ?? null,
      output: (record.output ?? {}) as never
    }
  });
}

async function persistOutcome(
  deps: AnalysisHandlerDeps,
  analysisRunId: string,
  result: Awaited<ReturnType<typeof runAnalysisPipeline>>,
  correlationId: string
): Promise<void> {
  const status = result.status === "SUCCEEDED" ? "SUCCEEDED" : result.status === "CANCELLED" ? "CANCELLED" : "FAILED";

  await deps.prisma.analysisRun.update({
    where: { id: analysisRunId },
    data: {
      status,
      completedAt: new Date(),
      errorCode: result.error?.code ?? null,
      errorMessage: result.error?.message ?? null
    }
  });

  await deps.audit.record({
    actor: "capibara-worker",
    actorType: "worker",
    action: `analysis_run.${status.toLowerCase()}`,
    resourceType: "AnalysisRun",
    resourceId: analysisRunId,
    analysisRunId,
    outcome: status === "SUCCEEDED" ? "success" : "failure",
    metadata: {
      correlationId,
      durationMs: result.totalDurationMs,
      stages: result.stages.map((stage) => `${stage.stage}:${stage.status}`),
      pullRequest: result.publish?.pullRequest?.number ?? null,
      skippedReason: result.publish?.skippedReason ?? null
    }
  });
}

/** Exported for reuse when persisting diff output. */
export { changeFingerprint, sha256Hex };
