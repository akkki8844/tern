import { getLogger, type PipelineStageName } from "@tern/shared";
import { runStage, type StageContext, type StageOutcome } from "./stage.js";
import {
  createPublishStage,
  diffStage,
  discoverStage,
  migrateStage,
  planStage,
  scanStage,
  testStage,
  validateStage,
  type AnalysisInput,
  type PublishOutput
} from "./stages.js";

const logger = getLogger("analysis-pipeline");

export interface PipelineOptions {
  /** When false the PUBLISH stage reports its plan without writing to GitHub. */
  publish: boolean;
  branchPrefix?: string;
}

export interface PipelineResult {
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  stages: StageOutcome[];
  totalDurationMs: number;
  publish?: PublishOutput;
  error?: { code: string; message: string; stage?: PipelineStageName };
  /** Semantic repository scan from the SCAN stage (ast engine), when it ran. */
  scan?: import("@tern/scanner").RepositoryScan;
  /** Legacy usage projection, kept for consumers of the flat shape. */
  usages?: import("@tern/shared").AffectedUsage[];
}

/**
 * The analysis pipeline.
 *
 * Stages run in a fixed order and each one is typed: the output of a stage is the
 * input of the next, so a stage cannot accidentally consume data that has not been
 * produced. Every stage is timed, logged and persisted through `runStage`, and any
 * failure stops the pipeline immediately with the failing stage named in the error.
 *
 * The orchestration is written out explicitly rather than hidden behind a generic
 * chain combinator: eight stages read better than a type-level fold, and the data
 * flow between them stays visible.
 */
export async function runAnalysisPipeline(
  input: AnalysisInput,
  context: StageContext,
  options: PipelineOptions
): Promise<PipelineResult> {
  const stages: StageOutcome[] = [];
  const start = Date.now();
  const publishStage = createPublishStage({
    enabled: options.publish,
    branchPrefix: options.branchPrefix ?? "tern/migrate-"
  });

  try {
    const discovered = await runStage(discoverStage, input, context, stages);
    const diffed = await runStage(diffStage, discovered, context, stages);

    if (diffed.changes.length === 0) {
      logger.info("no breaking changes detected; pipeline finished early", {
        analysisRunId: context.analysisRunId
      });
      return {
        status: "SUCCEEDED",
        stages,
        totalDurationMs: Date.now() - start,
        publish: { pullRequest: null, skippedReason: "no breaking changes detected" }
      };
    }

    const scanned = await runStage(scanStage, { ...discovered, ...diffed }, context, stages);
    const planned = await runStage(planStage, { ...discovered, ...scanned }, context, stages);
    const migrated = await runStage(migrateStage, planned, context, stages);
    const validated = await runStage(validateStage, migrated, context, stages);
    const tested = await runStage(testStage, validated, context, stages);
    const publish = await runStage(publishStage, { ...tested, input }, context, stages);

    return {
      status: "SUCCEEDED",
      stages,
      totalDurationMs: Date.now() - start,
      publish,
      scan: tested.scan,
      usages: tested.usages
    };
  } catch (error) {
    const failed = stages.find((outcome) => outcome.status === "FAILED" || outcome.status === "CANCELLED");
    const cancelled = failed?.status === "CANCELLED";
    return {
      status: cancelled ? "CANCELLED" : "FAILED",
      stages,
      totalDurationMs: Date.now() - start,
      error: {
        code: failed?.errorCode ?? "PIPELINE_FAILED",
        message: failed?.errorMessage ?? (error instanceof Error ? error.message : "Pipeline failed"),
        stage: failed?.stage
      }
    };
  }
}

export const PIPELINE_STAGE_ORDER: readonly PipelineStageName[] = [
  "DISCOVER",
  "DIFF",
  "SCAN",
  "PLAN",
  "MIGRATE",
  "VALIDATE",
  "TEST",
  "PUBLISH"
];
