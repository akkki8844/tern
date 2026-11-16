import { randomUUID } from "node:crypto";
import { JobError, ValidationError, fingerprint, getLogger } from "@capibara/shared";
import type { JobStore } from "@capibara/jobs";
import type { PrismaClient } from "@capibara/db";
import type { AuditLogger } from "@capibara/db";
import { parseWebhookPayload } from "@capibara/github";
import { JOB_TYPES, type WebhookJobPayload } from "../job-types.js";
import type { JobContext, JobHandler } from "../worker.js";

const logger = getLogger("handler:webhook");

export interface WebhookHandlerDeps {
  prisma: PrismaClient;
  jobs: JobStore;
  audit: AuditLogger;
}

/**
 * Turn a stored webhook delivery into domain state.
 *
 * The HTTP endpoint only verifies, persists and enqueues; everything that can be
 * slow or can fail lives here, where it gets retries, backoff and observability.
 */
export function createWebhookHandler(deps: WebhookHandlerDeps): JobHandler {
  return {
    type: JOB_TYPES.WEBHOOK,

    async handle(context: JobContext) {
      const payload = context.job.payload as unknown as WebhookJobPayload;
      if (typeof payload.webhookEventId !== "string") {
        throw new ValidationError("Webhook job payload is missing webhookEventId", {
          code: "JOB_PAYLOAD_INVALID"
        });
      }

      const event = await deps.prisma.webhookEvent.findUnique({ where: { id: payload.webhookEventId } });
      if (!event) {
        throw new JobError("Webhook event no longer exists", { code: "WEBHOOK_EVENT_MISSING", retryable: false });
      }
      if (event.status === "PROCESSED") {
        context.logger.info("webhook already processed; nothing to do", { deliveryId: event.deliveryId });
        return { skipped: "already processed" };
      }

      const parsed = parseWebhookPayload(event.event, JSON.stringify(event.summary ?? {}));

      if (parsed.event !== "push") {
        await deps.prisma.webhookEvent.update({
          where: { id: event.id },
          data: { status: "IGNORED", processedAt: new Date() }
        });
        return { ignored: event.event };
      }

      const push = parsed.payload;
      const branch = push.ref.replace(/^refs\/heads\//, "");
      const [owner, name] = push.repository.full_name.split("/");

      const repository = await deps.prisma.repository.findUnique({ where: { githubId: push.repository.id } });
      if (!repository) {
        await deps.prisma.webhookEvent.update({
          where: { id: event.id },
          data: { status: "IGNORED", processedAt: new Date(), errorMessage: "repository is not installed" }
        });
        logger.warn("push for a repository Capibara does not manage", { repository: push.repository.full_name });
        return { ignored: "unknown repository" };
      }

      if (branch !== repository.defaultBranch) {
        await deps.prisma.webhookEvent.update({
          where: { id: event.id },
          data: { status: "IGNORED", processedAt: new Date(), errorMessage: `branch ${branch} is not the default branch` }
        });
        return { ignored: "non-default branch" };
      }

      // One run per (repository, base, head): a redelivered webhook cannot fork a
      // second pipeline for the same commit range.
      const idempotencyKey = fingerprint(`${repository.id}:${push.before}:${push.after}`);
      const run = await deps.prisma.analysisRun.upsert({
        where: { idempotencyKey },
        create: {
          repositoryId: repository.id,
          baseCommitSha: push.before,
          headCommitSha: push.after,
          idempotencyKey,
          triggeredBy: "webhook",
          status: "PENDING"
        },
        update: {}
      });

      const enqueued = await deps.jobs.enqueue({
        type: JOB_TYPES.ANALYSIS,
        payload: { analysisRunId: run.id, correlationId: payload.correlationId ?? randomUUID() },
        idempotencyKey: `${JOB_TYPES.ANALYSIS}:${run.id}`,
        analysisRunId: run.id,
        maxAttempts: 3
      });

      await deps.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: "PROCESSED", processedAt: new Date(), jobId: enqueued.job.id }
      });

      await deps.audit.record({
        actor: "capibara-worker",
        actorType: "worker",
        action: "analysis_run.enqueued",
        resourceType: "AnalysisRun",
        resourceId: run.id,
        repositoryId: repository.id,
        analysisRunId: run.id,
        metadata: { deliveryId: event.deliveryId, base: push.before, head: push.after }
      });

      context.logger.info("push accepted", {
        repository: `${owner}/${name}`,
        analysisRunId: run.id,
        jobCreated: enqueued.created
      });

      return { analysisRunId: run.id, jobId: enqueued.job.id, created: enqueued.created };
    }
  };
}
