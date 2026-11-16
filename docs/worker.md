# Worker runtime

Implementation: `apps/worker/src/worker.ts` and `apps/worker/src/index.ts`.

## Startup

1. `initConfig()` validates the environment. A misconfiguration aborts startup.
2. Logging is configured from the validated configuration.
3. The database connection is verified with `SELECT 1`. An unreachable database aborts
   startup rather than producing a worker that accepts nothing.
4. Orphaned workspaces older than one hour are removed.
5. Jobs abandoned by previously crashed workers are reclaimed.
6. Polling begins.

## Polling

Each tick claims at most `concurrency - inFlight` jobs in one atomic statement. When a
tick claims nothing the worker sleeps for `WORKER_POLL_INTERVAL_MS` plus up to 20%
jitter, and wakes immediately if shutdown starts. There is no busy loop and no
unbounded query rate. A failing poll is logged and backs off; it never kills the worker.

## Job execution

* Each job runs with its own `AbortController`.
* A heartbeat timer renews the lease every `WORKER_HEARTBEAT_INTERVAL_MS`.
* If the heartbeat finds the lease is gone, the handler is aborted — this is the
  mechanism that prevents two workers from finishing the same job.
* If the heartbeat reports `cancelRequested`, the handler is aborted.
* If the handler completes after being aborted, the result is discarded rather than
  written over another worker's outcome.

## Graceful shutdown

`SIGTERM`/`SIGINT` stop claiming immediately and then wait for in-flight jobs, up to
`WORKER_SHUTDOWN_TIMEOUT_MS`. Jobs that finish in time complete normally. Jobs that do
not are aborted; because the failure is classified as cancelled-and-retryable they go
back to `PENDING` and another worker picks them up. Anything still stuck is recovered by
lease expiry. **No job is lost and no job is executed twice.**

A second signal exits immediately with status 1.

In containers, `tini` is the entrypoint so `SIGTERM` actually reaches Node, and
`stop_grace_period` in `docker/docker-compose.yml` is longer than the shutdown timeout.

## Handlers

| Type | Purpose |
| --- | --- |
| `webhook.process` | Turn a stored delivery into an `AnalysisRun` and enqueue the analysis |
| `analysis.run` | Run the eight-stage pipeline and persist everything it produced |

Handlers receive `{ job, logger, signal, heartbeat }`. Long-running work should call
`heartbeat()` at natural checkpoints; the pipeline does this between stages.

## Tests

`apps/worker/src/worker.test.ts` runs against a real PostgreSQL engine and covers:
single execution under two competing workers, the concurrency limit, retry with
backoff, non-retryable failure, startup recovery of crashed jobs, abort on lease loss,
abort on cancellation, lease renewal across a long job, graceful shutdown that waits,
forced shutdown that requeues, refusal to claim after shutdown, and survival of a
transient store failure.
