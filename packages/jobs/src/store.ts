import { randomUUID } from "node:crypto";
import type { SqlClient } from "@tern/db";
import { JobError, getLogger, redactValue } from "@tern/shared";
import type {
  ClaimOptions,
  EnqueueOptions,
  EnqueueResult,
  FailureInput,
  JobRecord,
  JobStats,
  JobStore,
  ReclaimResult
} from "./types.js";

const logger = getLogger("job-store");

/**
 * Every column the store reads back. Listed explicitly so a schema change that
 * removes a column fails loudly instead of silently returning undefined.
 */
const COLUMN_NAMES = [
  "id", "type", "status", "priority", "payload", "result", "idempotencyKey",
  "attempts", "maxAttempts", "availableAt", "startedAt", "completedAt",
  "lockedBy", "lockedAt", "leaseExpiresAt", "heartbeatAt", "cancelRequested",
  "errorCode", "errorMessage", "analysisRunId", "createdAt", "updatedAt"
] as const;

/** `j."id", j."type", ...` — for statements that alias the table as `j`. */
const JOB_COLUMNS = COLUMN_NAMES.map((c) => `j."${c}"`).join(", ");
/** `"id", "type", ...` — for statements without an alias. */
const JOB_COLUMNS_UNALIASED = COLUMN_NAMES.map((c) => `"${c}"`).join(", ");

/**
 * PostgreSQL-backed job store.
 *
 * Design notes
 *  - Claiming is a single statement: a `FOR UPDATE SKIP LOCKED` CTE selects
 *    candidate rows and the same statement flips them to RUNNING. Two workers can
 *    never observe the same job as claimable, and a slow worker never blocks a fast
 *    one.
 *  - All timestamps are produced by the database (`now()`), so worker clock skew
 *    cannot corrupt scheduling, lease expiry or backoff.
 *  - A RUNNING job carries a lease. If the worker dies, the lease expires and
 *    `reclaimExpired` returns the job to PENDING (or FAILED when attempts run out).
 *  - Every value is bound as a parameter; no user input is ever interpolated into SQL.
 */
export class PostgresJobStore implements JobStore {
  constructor(private readonly sql: SqlClient) {}

  async enqueue(options: EnqueueOptions): Promise<EnqueueResult> {
    if (!options.type || options.type.length > 100) {
      throw new JobError("Job type must be a non-empty string of at most 100 characters", {
        code: "JOB_TYPE_INVALID"
      });
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50) {
      throw new JobError("maxAttempts must be an integer between 1 and 50", { code: "JOB_MAX_ATTEMPTS_INVALID" });
    }
    const delayMs = Math.max(0, options.delayMs ?? 0);

    const rows = await this.sql.query<RawJob>(
      `
      INSERT INTO "Job" (
        "id", "type", "status", "priority", "payload", "idempotencyKey",
        "attempts", "maxAttempts", "availableAt", "analysisRunId", "createdAt", "updatedAt"
      )
      VALUES (
        $1, $2, 'PENDING', $3, $4::jsonb, $5,
        0, $6, now() + make_interval(secs => $7::double precision / 1000), $8, now(), now()
      )
      ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING ${JOB_COLUMNS_UNALIASED}
      `,
      [
        randomUUID(),
        options.type,
        options.priority ?? 0,
        JSON.stringify(options.payload ?? {}),
        options.idempotencyKey ?? null,
        maxAttempts,
        delayMs,
        options.analysisRunId ?? null
      ]
    );

    if (rows.length > 0) {
      const job = toJobRecord(rows[0]);
      logger.info("job enqueued", { jobId: job.id, type: job.type, priority: job.priority, delayMs });
      return { job, created: true };
    }

    // ON CONFLICT DO NOTHING fired: an equivalent job already exists.
    if (!options.idempotencyKey) {
      throw new JobError("Job insert produced no row", { code: "JOB_ENQUEUE_FAILED", retryable: true });
    }
    const existing = await this.findByIdempotencyKey(options.idempotencyKey);
    if (!existing) {
      throw new JobError("Job insert conflicted but the existing job could not be read", {
        code: "JOB_ENQUEUE_RACE",
        retryable: true
      });
    }
    logger.debug("job already enqueued for idempotency key", { jobId: existing.id, type: existing.type });
    return { job: existing, created: false };
  }

  async claim(options: ClaimOptions): Promise<JobRecord[]> {
    if (options.types.length === 0 || options.limit < 1) return [];

    const rows = await this.sql.query<RawJob>(
      `
      WITH candidate AS (
        SELECT "id" FROM "Job"
        WHERE "status" = 'PENDING'
          AND "cancelRequested" = false
          AND "availableAt" <= now()
          AND "type" = ANY($1::text[])
        ORDER BY "priority" DESC, "availableAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      UPDATE "Job" j
      SET "status" = 'RUNNING',
          "attempts" = j."attempts" + 1,
          "startedAt" = COALESCE(j."startedAt", now()),
          "lockedBy" = $3,
          "lockedAt" = now(),
          "heartbeatAt" = now(),
          "leaseExpiresAt" = now() + make_interval(secs => $4::double precision / 1000),
          "updatedAt" = now()
      FROM candidate c
      WHERE j."id" = c."id"
      RETURNING ${JOB_COLUMNS}
      `,
      [options.types as string[], options.limit, options.workerId, options.leaseDurationMs]
    );

    return rows.map(toJobRecord);
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    leaseDurationMs: number
  ): Promise<{ cancelRequested: boolean } | null> {
    const rows = await this.sql.query<{ cancelRequested: boolean }>(
      `
      UPDATE "Job"
      SET "heartbeatAt" = now(),
          "leaseExpiresAt" = now() + make_interval(secs => $3::double precision / 1000),
          "updatedAt" = now()
      WHERE "id" = $1 AND "lockedBy" = $2 AND "status" = 'RUNNING'
      RETURNING "cancelRequested"
      `,
      [jobId, workerId, leaseDurationMs]
    );
    if (rows.length === 0) return null;
    return { cancelRequested: Boolean(rows[0].cancelRequested) };
  }

  async complete(jobId: string, workerId: string, result: unknown): Promise<JobRecord | null> {
    const rows = await this.sql.query<RawJob>(
      `
      UPDATE "Job" j
      SET "status" = 'SUCCEEDED',
          "result" = $3::jsonb,
          "completedAt" = now(),
          "lockedBy" = NULL,
          "lockedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "errorCode" = NULL,
          "errorMessage" = NULL,
          "updatedAt" = now()
      WHERE j."id" = $1 AND j."lockedBy" = $2 AND j."status" = 'RUNNING'
      RETURNING ${JOB_COLUMNS}
      `,
      [jobId, workerId, JSON.stringify(result ?? null)]
    );
    if (rows.length === 0) {
      logger.warn("completion ignored: lease no longer held", { jobId, workerId });
      return null;
    }
    return toJobRecord(rows[0]);
  }

  async fail(jobId: string, workerId: string, failure: FailureInput): Promise<JobRecord | null> {
    const details = failure.details ? JSON.stringify(redactValue(failure.details)) : null;
    const rows = await this.sql.query<RawJob>(
      `
      UPDATE "Job" j
      SET "status" = CASE
            WHEN $3::boolean = false THEN 'FAILED'::"JobStatus"
            WHEN j."attempts" >= j."maxAttempts" THEN 'FAILED'::"JobStatus"
            ELSE 'PENDING'::"JobStatus"
          END,
          "availableAt" = CASE
            WHEN $3::boolean AND j."attempts" < j."maxAttempts"
              THEN now() + make_interval(secs => $4::double precision / 1000)
            ELSE j."availableAt"
          END,
          "completedAt" = CASE
            WHEN $3::boolean = false OR j."attempts" >= j."maxAttempts" THEN now()
            ELSE NULL
          END,
          "errorCode" = $5,
          "errorMessage" = $6,
          "errorDetails" = $7::jsonb,
          "lockedBy" = NULL,
          "lockedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "updatedAt" = now()
      WHERE j."id" = $1 AND j."lockedBy" = $2 AND j."status" = 'RUNNING'
      RETURNING ${JOB_COLUMNS}
      `,
      [
        jobId,
        workerId,
        failure.retryable,
        Math.max(0, failure.retryDelayMs),
        failure.code.slice(0, 100),
        failure.message.slice(0, 2000),
        details
      ]
    );
    if (rows.length === 0) {
      logger.warn("failure ignored: lease no longer held", { jobId, workerId });
      return null;
    }
    const job = toJobRecord(rows[0]);
    logger.warn("job attempt failed", {
      jobId: job.id,
      type: job.type,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      status: job.status,
      errorCode: job.errorCode
    });
    return job;
  }

  async cancel(jobId: string): Promise<JobRecord | null> {
    const rows = await this.sql.query<RawJob>(
      `
      UPDATE "Job" j
      SET "cancelRequested" = true,
          "status" = CASE WHEN j."status" = 'PENDING' THEN 'CANCELLED'::"JobStatus" ELSE j."status" END,
          "completedAt" = CASE WHEN j."status" = 'PENDING' THEN now() ELSE j."completedAt" END,
          "updatedAt" = now()
      WHERE j."id" = $1 AND j."status" IN ('PENDING', 'RUNNING')
      RETURNING ${JOB_COLUMNS}
      `,
      [jobId]
    );
    return rows.length > 0 ? toJobRecord(rows[0]) : null;
  }

  async reclaimExpired(): Promise<ReclaimResult> {
    // Jobs with attempts left go back to the queue immediately.
    const requeued = await this.sql.query<{ id: string }>(
      `
      UPDATE "Job"
      SET "status" = 'PENDING',
          "lockedBy" = NULL,
          "lockedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "availableAt" = now(),
          "errorCode" = 'JOB_LEASE_EXPIRED',
          "errorMessage" = 'Worker lease expired before the job completed; job requeued',
          "updatedAt" = now()
      WHERE "status" = 'RUNNING'
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" < now()
        AND "attempts" < "maxAttempts"
      RETURNING "id"
      `
    );

    // Jobs that already used every attempt are terminal.
    const exhausted = await this.sql.query<{ id: string }>(
      `
      UPDATE "Job"
      SET "status" = 'FAILED',
          "lockedBy" = NULL,
          "lockedAt" = NULL,
          "leaseExpiresAt" = NULL,
          "completedAt" = now(),
          "errorCode" = 'JOB_LEASE_EXPIRED',
          "errorMessage" = 'Worker lease expired and no attempts remain',
          "updatedAt" = now()
      WHERE "status" = 'RUNNING'
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" < now()
        AND "attempts" >= "maxAttempts"
      RETURNING "id"
      `
    );

    const result = { requeued: requeued.map((r) => r.id), exhausted: exhausted.map((r) => r.id) };
    if (result.requeued.length || result.exhausted.length) {
      logger.warn("recovered jobs from expired leases", {
        requeued: result.requeued.length,
        exhausted: result.exhausted.length
      });
    }
    return result;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const rows = await this.sql.query<RawJob>(`SELECT ${JOB_COLUMNS} FROM "Job" j WHERE j."id" = $1`, [jobId]);
    return rows.length > 0 ? toJobRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<JobRecord | null> {
    const rows = await this.sql.query<RawJob>(`SELECT ${JOB_COLUMNS} FROM "Job" j WHERE j."idempotencyKey" = $1`, [key]);
    return rows.length > 0 ? toJobRecord(rows[0]) : null;
  }

  async stats(): Promise<JobStats> {
    const rows = await this.sql.query<{ status: string; count: number | bigint | string }>(
      `SELECT "status", COUNT(*)::int AS count FROM "Job" GROUP BY "status"`
    );
    const stats: JobStats = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
      const count = Number(row.count);
      switch (row.status) {
        case "PENDING":
          stats.pending = count;
          break;
        case "RUNNING":
          stats.running = count;
          break;
        case "SUCCEEDED":
          stats.succeeded = count;
          break;
        case "FAILED":
          stats.failed = count;
          break;
        case "CANCELLED":
          stats.cancelled = count;
          break;
      }
    }
    return stats;
  }

  async purgeTerminal(olderThanMs: number): Promise<number> {
    const rows = await this.sql.query<{ id: string }>(
      `
      DELETE FROM "Job"
      WHERE "status" IN ('SUCCEEDED', 'CANCELLED')
        AND "completedAt" IS NOT NULL
        AND "completedAt" < now() - make_interval(secs => $1::double precision / 1000)
      RETURNING "id"
      `,
      [Math.max(0, olderThanMs)]
    );
    return rows.length;
  }
}

interface RawJob {
  id: string;
  type: string;
  status: string;
  priority: number;
  payload: unknown;
  result: unknown;
  idempotencyKey: string | null;
  attempts: number;
  maxAttempts: number;
  availableAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  lockedBy: string | null;
  lockedAt: Date | string | null;
  leaseExpiresAt: Date | string | null;
  heartbeatAt: Date | string | null;
  cancelRequested: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  analysisRunId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOptionalDate(value: Date | string | null): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

function toJobRecord(raw: RawJob): JobRecord {
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status as JobRecord["status"],
    priority: Number(raw.priority),
    payload: parseJson(raw.payload),
    result: typeof raw.result === "string" ? safeParse(raw.result) : (raw.result ?? null),
    idempotencyKey: raw.idempotencyKey,
    attempts: Number(raw.attempts),
    maxAttempts: Number(raw.maxAttempts),
    availableAt: toDate(raw.availableAt),
    startedAt: toOptionalDate(raw.startedAt),
    completedAt: toOptionalDate(raw.completedAt),
    lockedBy: raw.lockedBy,
    lockedAt: toOptionalDate(raw.lockedAt),
    leaseExpiresAt: toOptionalDate(raw.leaseExpiresAt),
    heartbeatAt: toOptionalDate(raw.heartbeatAt),
    cancelRequested: Boolean(raw.cancelRequested),
    errorCode: raw.errorCode,
    errorMessage: raw.errorMessage,
    analysisRunId: raw.analysisRunId,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt)
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    const parsed = safeParse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
