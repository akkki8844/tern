# Job system

Tern's queue is PostgreSQL. There is no Redis and no BullMQ, and no scheduling state
lives in process memory.

Implementation: `packages/jobs`.

## States

```
PENDING ──claim──▶ RUNNING ──complete──▶ SUCCEEDED
   ▲                  │
   │                  ├──fail (attempts left, retryable)──▶ PENDING (with backoff)
   │                  ├──fail (no attempts / not retryable)─▶ FAILED
   │                  └──lease expires──▶ PENDING or FAILED
   └──cancel (while pending)──▶ CANCELLED
```

A RUNNING job that is cancelled is **not** killed from the outside: the next heartbeat
reports `cancelRequested`, and the handler's `AbortSignal` fires so it can stop cleanly.

## Atomic claiming

Claiming is a single statement. A CTE selects candidates with
`FOR UPDATE SKIP LOCKED` and the same statement flips them to `RUNNING`:

```sql
WITH candidate AS (
  SELECT "id" FROM "Job"
  WHERE "status" = 'PENDING' AND "cancelRequested" = false
    AND "availableAt" <= now() AND "type" = ANY($1::text[])
  ORDER BY "priority" DESC, "availableAt" ASC, "createdAt" ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE "Job" j
SET "status" = 'RUNNING', "attempts" = j."attempts" + 1, "lockedBy" = $3,
    "leaseExpiresAt" = now() + make_interval(secs => $4::double precision / 1000), ...
FROM candidate c WHERE j."id" = c."id"
RETURNING ...;
```

Consequences:

* two workers can never observe the same job as claimable;
* a slow worker never blocks a fast one (`SKIP LOCKED`);
* all timestamps come from the database, so worker clock skew cannot corrupt
  scheduling, backoff or lease expiry;
* every value is bound as a parameter — no user input is ever interpolated into SQL.

## Leases and crash recovery

A claimed job carries `lockedBy` and `leaseExpiresAt`. The worker renews the lease on a
timer (`WORKER_HEARTBEAT_INTERVAL_MS`). If the process dies, the lease expires and
`reclaimExpired()` returns the job to `PENDING` — or moves it to `FAILED` when no
attempts remain. Workers call this at startup and periodically while polling.

If a heartbeat discovers the lease is no longer held (another worker reclaimed it), the
running handler is aborted immediately. That is what prevents duplicate execution after
a network partition.

## Retries

Failures are classified:

* a typed `TernError` declares `retryable` explicitly (a `ConfigurationError` is not
  retryable, a `GitHubError` for a 502 is);
* an untyped error is treated as an unexpected fault and **is** retried, bounded by
  `maxAttempts`.

Backoff is exponential with jitter: 30s, 60s, 120s, … capped at 15 minutes.

## Idempotency

`enqueue({ idempotencyKey })` uses `ON CONFLICT DO NOTHING` on a unique index. Enqueuing
twice with the same key returns the existing job with `created: false`. Webhook
deliveries and pipeline re-entry both rely on this.

## No busy loops

The worker sleeps for `WORKER_POLL_INTERVAL_MS` plus jitter between empty polls and
wakes immediately on shutdown. Stale-job reclamation runs at most once per half lease
period, not on every poll.

## Tests

`packages/jobs/src/store.test.ts` runs against a real PostgreSQL 16 engine (PGlite,
compiled to WebAssembly) using the exact DDL from `packages/db/prisma/migrations`.
Multi-connection concurrency — the property `SKIP LOCKED` exists for — needs a real
server and runs in `packages/jobs/src/concurrency.test.ts` whenever
`TERN_TEST_DATABASE_URL` is set. CI always sets it; locally the suite is skipped with an
explicit reason rather than silently passing.
