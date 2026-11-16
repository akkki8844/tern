# Deployment

## Prerequisites

* Node.js 20 or newer
* PostgreSQL 14 or newer
* A GitHub App (see [`github-app-setup.md`](github-app-setup.md))
* Optionally a Fireworks AI key; without one, migrations remain deterministic

## Configuration

Copy `.env.example` and fill it in. Every variable is documented in
[`environment.md`](environment.md). Configuration is validated at startup: a bad
deployment fails immediately with a list of every problem, instead of starting and
misbehaving later.

## Database

```bash
npm run db:generate    # generate the Prisma client
npm run db:deploy      # apply migrations (production)
npm run db:migrate     # create + apply a migration (development)
npm run db:seed        # optional local seed data
```

`db:deploy` is the production path; it applies the checked-in SQL and never rewrites the
schema on its own.

## Running

```bash
npm install
npm run build          # packages (tsc -b) then the Next.js app
npm run start          # web
npm run start:worker   # worker (run at least one)
```

The web app and the worker are independent processes and scale independently. Multiple
workers are safe: job claiming is atomic and leases prevent duplicate execution.

## Docker

```bash
cp .env.example .env
npm run docker:build
npm run docker:up
npm run docker:logs
```

`docker/docker-compose.yml` starts PostgreSQL, the web app and the worker. The worker
image includes `git` and uses `tini` so `SIGTERM` reaches Node and the graceful drain
runs; `stop_grace_period` is 60s, comfortably above the default
`WORKER_SHUTDOWN_TIMEOUT_MS` of 30s. Both images run as a non-root user.

## Health checks

Point liveness probes at `/api/health` and readiness probes at `/api/health/detailed`
(503 when a dependency is down).

## Operational notes

* **Rolling restarts are safe.** Send `SIGTERM`, allow at least
  `WORKER_SHUTDOWN_TIMEOUT_MS` for the drain. Anything that cannot finish is requeued by
  lease expiry.
* **Workspace volume.** `WORKSPACE_ROOT` must be writable and should be a real volume,
  not the container's overlay filesystem. Orphans are reaped at startup.
* **Logs** are JSON on stdout. Do not enable `LOG_PRETTY` in production (it is forced
  off anyway).
* **Backups.** PostgreSQL is the single source of truth; nothing else needs backing up.
