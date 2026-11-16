/**
 * Job system types.
 *
 * A job is a durable unit of background work. PostgreSQL is the only place job
 * state lives; no scheduling state is held in process memory.
 */

export const JOB_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobPayload = Record<string, unknown>;

export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  priority: number;
  payload: JobPayload;
  result: unknown;
  idempotencyKey: string | null;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  cancelRequested: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  analysisRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueOptions {
  type: string;
  payload?: JobPayload;
  /** Higher runs first. */
  priority?: number;
  maxAttempts?: number;
  /** Delay before the job becomes claimable. */
  delayMs?: number;
  /**
   * Deduplication key. Enqueuing twice with the same key returns the existing job
   * instead of creating a second one — this is what makes webhook delivery and
   * pipeline re-entry safe.
   */
  idempotencyKey?: string;
  analysisRunId?: string;
}

export interface EnqueueResult {
  job: JobRecord;
  /** False when an existing job with the same idempotency key was returned. */
  created: boolean;
}

export interface ClaimOptions {
  /** Only claim jobs of these types. */
  types: readonly string[];
  /** Identity of the claiming worker; recorded on the job. */
  workerId: string;
  /** How long the claim is valid before another worker may take over. */
  leaseDurationMs: number;
  /** Maximum number of jobs to claim in this call. */
  limit: number;
}

export interface FailureInput {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** When false the job goes straight to FAILED regardless of remaining attempts. */
  retryable: boolean;
  /** Delay before the next attempt. Ignored when the job will not be retried. */
  retryDelayMs: number;
}

export interface JobStats {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface ReclaimResult {
  /** Jobs whose lease expired and that were returned to PENDING. */
  requeued: string[];
  /** Jobs whose lease expired with no attempts left; moved to FAILED. */
  exhausted: string[];
}

export interface JobStore {
  enqueue(options: EnqueueOptions): Promise<EnqueueResult>;
  claim(options: ClaimOptions): Promise<JobRecord[]>;
  /**
   * Renew a lease. Returns null when the lease is no longer held (the job was
   * reclaimed, cancelled or completed elsewhere) — the handler must then stop.
   */
  heartbeat(jobId: string, workerId: string, leaseDurationMs: number): Promise<{ cancelRequested: boolean } | null>;
  complete(jobId: string, workerId: string, result: unknown): Promise<JobRecord | null>;
  fail(jobId: string, workerId: string, failure: FailureInput): Promise<JobRecord | null>;
  /** Request cancellation. PENDING jobs are cancelled immediately. */
  cancel(jobId: string): Promise<JobRecord | null>;
  /** Recover jobs abandoned by crashed workers. */
  reclaimExpired(now?: Date): Promise<ReclaimResult>;
  get(jobId: string): Promise<JobRecord | null>;
  findByIdempotencyKey(key: string): Promise<JobRecord | null>;
  stats(): Promise<JobStats>;
  /** Delete terminal jobs older than the cutoff. Returns the number deleted. */
  purgeTerminal(olderThanMs: number): Promise<number>;
}
