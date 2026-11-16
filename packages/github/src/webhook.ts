import { createHmac } from "node:crypto";
import { z } from "zod";
import { AuthenticationError, ValidationError, safeEqual, type Secret } from "@tern/shared";

/** GitHub signs webhook bodies with HMAC-SHA256 and this exact header. */
export const SIGNATURE_HEADER = "x-hub-signature-256";
export const DELIVERY_HEADER = "x-github-delivery";
export const EVENT_HEADER = "x-github-event";

const SIGNATURE_PREFIX = "sha256=";
/** GitHub's documented maximum webhook payload size. */
export const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Verify a GitHub webhook signature.
 *
 * Properties:
 *  - HMAC is computed over the exact raw bytes GitHub sent (never a re-serialised body)
 *  - comparison is constant time
 *  - a missing, malformed or wrongly-prefixed header is a failure, never a bypass
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: Secret): boolean {
  if (secret.isEmpty) return false;
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  const provided = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const expected = createHmac("sha256", secret.reveal()).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, provided.toLowerCase());
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

const repositorySchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean().optional().default(false),
  default_branch: z.string().min(1).optional().default("main"),
  html_url: z.string().url().optional(),
  owner: z.object({ login: z.string().min(1) }).optional()
});

const installationSchema = z.object({
  id: z.number().int(),
  account: z.object({ id: z.number().int().optional(), login: z.string().min(1), type: z.string().optional() }).optional()
});

const pushEventSchema = z.object({
  ref: z.string().min(1),
  before: z.string().min(1),
  after: z.string().min(1),
  repository: repositorySchema,
  installation: installationSchema.optional(),
  commits: z
    .array(
      z.object({
        id: z.string(),
        added: z.array(z.string()).optional().default([]),
        modified: z.array(z.string()).optional().default([]),
        removed: z.array(z.string()).optional().default([])
      })
    )
    .optional()
    .default([])
});

const installationEventSchema = z.object({
  action: z.string().min(1),
  installation: installationSchema,
  repositories: z.array(repositorySchema.partial({ default_branch: true, private: true })).optional()
});

const installationRepositoriesEventSchema = z.object({
  action: z.string().min(1),
  installation: installationSchema,
  repositories_added: z.array(repositorySchema.partial({ default_branch: true, private: true })).optional(),
  repositories_removed: z.array(repositorySchema.partial({ default_branch: true, private: true })).optional()
});

const pullRequestEventSchema = z.object({
  action: z.string().min(1),
  number: z.number().int(),
  pull_request: z.object({
    number: z.number().int(),
    merged: z.boolean().optional().default(false),
    merged_by: z.object({ login: z.string() }).nullable().optional(),
    state: z.string()
  }),
  repository: repositorySchema,
  installation: installationSchema.optional()
});

export type PushEvent = z.infer<typeof pushEventSchema>;
export type InstallationEvent = z.infer<typeof installationEventSchema>;
export type InstallationRepositoriesEvent = z.infer<typeof installationRepositoriesEventSchema>;
export type PullRequestEvent = z.infer<typeof pullRequestEventSchema>;

export type ParsedWebhook =
  | { event: "push"; payload: PushEvent }
  | { event: "installation"; payload: InstallationEvent }
  | { event: "installation_repositories"; payload: InstallationRepositoriesEvent }
  | { event: "pull_request"; payload: PullRequestEvent }
  | { event: "ping"; payload: Record<string, unknown> }
  | { event: "unsupported"; payload: Record<string, unknown> };

/**
 * Parse a webhook body that has already passed signature verification.
 * Unknown events are reported as `unsupported` (and later ignored) rather than
 * causing an error: GitHub sends events we did not subscribe to.
 */
export function parseWebhookPayload(event: string, rawBody: string): ParsedWebhook {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new ValidationError("Webhook body is not valid JSON", { code: "WEBHOOK_BODY_INVALID" });
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ValidationError("Webhook body must be a JSON object", { code: "WEBHOOK_BODY_INVALID" });
  }

  switch (event) {
    case "push":
      return { event: "push", payload: parseOrThrow(pushEventSchema, json, "push") };
    case "installation":
      return { event: "installation", payload: parseOrThrow(installationEventSchema, json, "installation") };
    case "installation_repositories":
      return {
        event: "installation_repositories",
        payload: parseOrThrow(installationRepositoriesEventSchema, json, "installation_repositories")
      };
    case "pull_request":
      return { event: "pull_request", payload: parseOrThrow(pullRequestEventSchema, json, "pull_request") };
    case "ping":
      return { event: "ping", payload: json as Record<string, unknown> };
    default:
      return { event: "unsupported", payload: json as Record<string, unknown> };
  }
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown, event: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Malformed ${event} webhook payload`, {
      code: "WEBHOOK_PAYLOAD_INVALID",
      details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 10) }
    });
  }
  return parsed.data;
}

/** Extract the delivery id used for duplicate/replay suppression. */
export function requireDeliveryId(header: string | null): string {
  if (!header || header.length < 8 || header.length > 200) {
    throw new AuthenticationError("Missing or malformed X-GitHub-Delivery header", {
      code: "WEBHOOK_DELIVERY_ID_INVALID"
    });
  }
  return header;
}

/** A non-sensitive projection of a webhook, safe to persist and log. */
export function summariseWebhook(parsed: ParsedWebhook): Record<string, unknown> {
  switch (parsed.event) {
    case "push":
      return {
        ref: parsed.payload.ref,
        before: parsed.payload.before,
        after: parsed.payload.after,
        repository: parsed.payload.repository.full_name,
        commitCount: parsed.payload.commits.length
      };
    case "installation":
      return {
        action: parsed.payload.action,
        installationId: parsed.payload.installation.id,
        account: parsed.payload.installation.account?.login,
        repositoryCount: parsed.payload.repositories?.length ?? 0
      };
    case "installation_repositories":
      return {
        action: parsed.payload.action,
        installationId: parsed.payload.installation.id,
        added: parsed.payload.repositories_added?.length ?? 0,
        removed: parsed.payload.repositories_removed?.length ?? 0
      };
    case "pull_request":
      return {
        action: parsed.payload.action,
        number: parsed.payload.number,
        repository: parsed.payload.repository.full_name,
        merged: parsed.payload.pull_request.merged
      };
    default:
      return {};
  }
}
