import { NextResponse } from "next/server";
import {
  ValidationError,
  getLogger,
  internalMessageOf,
  publicMessageOf,
  RateLimiter,
  isCapibaraError
} from "@capibara/shared";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  MAX_WEBHOOK_BODY_BYTES,
  SIGNATURE_HEADER,
  parseWebhookPayload,
  requireDeliveryId,
  summariseWebhook
} from "@capibara/github";
import { auditLogger, github, jobStore, prisma, serverConfig } from "../../_runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = getLogger("webhook-endpoint");

/** Coarse abuse protection for unauthenticated traffic hitting this endpoint. */
const limiter = new RateLimiter(600, 60_000);

/** Job type produced here. Duplicated from the worker to avoid a runtime dependency. */
const WEBHOOK_JOB_TYPE = "webhook.process";

/**
 * GitHub webhook endpoint.
 *
 * Contract:
 *  1. verify the HMAC signature over the raw body — before parsing anything
 *  2. reject malformed deliveries with 400, forged ones with 401
 *  3. de-duplicate on X-GitHub-Delivery (unique constraint, not a memory cache)
 *  4. persist a reduced, non-sensitive summary of the event
 *  5. enqueue a job and return 202 immediately — no pipeline work happens inline
 */
export async function POST(request: Request): Promise<NextResponse> {
  const config = serverConfig();
  const provider = github();

  const decision = limiter.check(clientKey(request));
  if (!decision.allowed) {
    return NextResponse.json({ error: { code: "RATE_LIMITED", message: "Too many requests." } }, { status: 429 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Payload too large." } }, { status: 413 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Payload too large." } }, { status: 413 });
  }

  // Signature first. Nothing is parsed, stored or logged from an unverified body.
  if (!provider.verifyWebhookSignature(rawBody, request.headers.get(SIGNATURE_HEADER))) {
    logger.warn("rejected webhook with an invalid signature", {
      event: request.headers.get(EVENT_HEADER),
      hasSignature: request.headers.get(SIGNATURE_HEADER) !== null
    });
    return NextResponse.json(
      { error: { code: "WEBHOOK_SIGNATURE_INVALID", message: "Signature verification failed." } },
      { status: 401 }
    );
  }

  try {
    const deliveryId = requireDeliveryId(request.headers.get(DELIVERY_HEADER));
    const event = request.headers.get(EVENT_HEADER);
    if (!event || event.length > 100) {
      throw new ValidationError("Missing or invalid X-GitHub-Event header", { code: "WEBHOOK_EVENT_INVALID" });
    }

    const parsed = parseWebhookPayload(event, rawBody);
    const summary = summariseWebhook(parsed);

    const db = prisma();

    // Replay/duplicate protection: the unique index on deliveryId is the authority.
    const existing = await db.webhookEvent.findUnique({ where: { deliveryId } });
    if (existing) {
      logger.info("duplicate webhook delivery ignored", { deliveryId, event });
      return NextResponse.json({ status: "duplicate", deliveryId }, { status: 202 });
    }

    const record = await db.webhookEvent.create({
      data: {
        deliveryId,
        event,
        action: typeof (parsed.payload as { action?: unknown }).action === "string"
          ? String((parsed.payload as { action?: string }).action)
          : null,
        installationId: extractInstallationId(parsed.payload),
        repositoryFullName: typeof summary.repository === "string" ? summary.repository : null,
        status: "RECEIVED",
        summary: summary as never
      }
    });

    if (parsed.event === "unsupported" || parsed.event === "ping") {
      await db.webhookEvent.update({
        where: { id: record.id },
        data: { status: "IGNORED", processedAt: new Date() }
      });
      return NextResponse.json({ status: "ignored", deliveryId }, { status: 202 });
    }

    // Hand off to the worker. The HTTP request never runs pipeline work.
    const enqueued = await jobStore().enqueue({
      type: WEBHOOK_JOB_TYPE,
      payload: { webhookEventId: record.id, correlationId: deliveryId },
      idempotencyKey: `${WEBHOOK_JOB_TYPE}:${deliveryId}`,
      maxAttempts: 5
    });

    await db.webhookEvent.update({ where: { id: record.id }, data: { jobId: enqueued.job.id } });

    await auditLogger().record({
      actor: "github",
      actorType: "github",
      action: "webhook.received",
      resourceType: "WebhookEvent",
      resourceId: record.id,
      metadata: { event, deliveryId, jobId: enqueued.job.id }
    });

    logger.info("webhook accepted", { deliveryId, event, jobId: enqueued.job.id, demoMode: config.demoMode });
    return NextResponse.json({ status: "accepted", deliveryId, jobId: enqueued.job.id }, { status: 202 });
  } catch (error) {
    if (isCapibaraError(error) && (error.category === "VALIDATION" || error.category === "AUTHENTICATION")) {
      logger.warn("rejected malformed webhook", { reason: error.message });
      return NextResponse.json(error.toPublicJSON(), { status: 400 });
    }
    logger.error("webhook processing failed", { reason: internalMessageOf(error) });
    return NextResponse.json(
      { error: { code: "WEBHOOK_FAILED", message: publicMessageOf(error) } },
      { status: 500 }
    );
  }
}

function extractInstallationId(payload: unknown): number | null {
  const value = (payload as { installation?: { id?: unknown } })?.installation?.id;
  return typeof value === "number" ? value : null;
}

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
