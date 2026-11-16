# Capibara

Capibara watches an API's OpenAPI specification, detects breaking changes, finds the code
that depends on them, migrates it, proves the result still builds and tests, and opens a
**draft** pull request for a human to review.

Capibara never merges anything.

```
OpenAPI change → breaking-change detection → repo-wide static analysis
   → affected usage detection → migration planning → deterministic migration
   → AI fallback (bounded) → patch validation → sandboxed install/build/test
   → branch → commit → draft PR → human review
```

## Status

The core runtime, the semantic diff engine and the repository-intelligence
scanner are complete and covered by the test suite (529+ tests). What that means
concretely:

| Area | State |
| --- | --- |
| Typed, validated configuration | Implemented |
| PostgreSQL + Prisma schema and migrations | Implemented; migration SQL verified against real PostgreSQL in CI |
| PostgreSQL job queue (no Redis, no BullMQ) | Implemented; PGlite store tests + real-server concurrency suite (`CAPIBARA_TEST_DATABASE_URL`) |
| Worker runtime with graceful shutdown and crash recovery | Implemented |
| Eight-stage pipeline orchestrator | Implemented |
| Semantic OpenAPI diff + breaking-change rule catalog | Implemented, 210 tests |
| Repository scanner (affected-usage intelligence) | Implemented: AST engine, symbol resolution, usage adapters, evidence + confidence, 8 golden repos, byte-deterministic |
| Conditional refinement (who actually sends/consumes a changed field) | Implemented (request-body + response-flow analysis) |
| Migration engine + patch validation | Implemented |
| GitHub App auth, webhooks, OAuth sign-in | Implemented; unsigned webhooks rejected |
| Fireworks AI provider with timeout, retry, schema validation | Implemented |
| Isolated per-job workspaces + sandboxed verify (install/build/test) | Implemented |
| Structured logging, redaction, error taxonomy | Implemented |
| Dashboard UI | Implemented: live data from PostgreSQL with graceful degraded states |
| Demo mode | Implemented (`capibara demo` or `npm run demo`) — full pipeline with in-memory providers |
| Docker deployment (web + worker + PostgreSQL) | Implemented (`docker/`) |
| CLI | Implemented: `capibara` — analyze / report / demo / doctor, Claude-Code-style visuals, `--json` + CI exit codes |

## Quick start

**CLI** — analyse two OpenAPI documents against your code. No database, no
GitHub App, no network:

```bash
npm install && npm run build
npx capibara doctor
npx capibara analyze --old demo/specs/acmepay-v1.yaml --new demo/specs/acmepay-v2.yaml demo/broken-app/src
# exit code 1 = breaking changes found; add --verbose for evidence chains, --json for CI
```

The demo runs the entire eight-stage pipeline offline:

```bash
npx capibara demo
```

**Full stack** (web dashboard + worker + PostgreSQL — the automated
GitHub-App workflow; needed in production later):

```bash
cp .env.example .env          # set DATABASE_URL at minimum
npm install
npm run db:deploy             # apply migrations
npm run build
npm run start                 # dashboard on :3000
npm run start:worker          # worker (in another shell)
```

## Layout

```
apps/cli       The `capibara` CLI — analyze, report, demo, doctor
apps/web       Next.js dashboard, webhook endpoint, OAuth, health checks
apps/worker    Worker runtime, job handlers, demo entrypoint
packages/*     shared, db, jobs, workspace, github, llm, openapi, scanner,
               migration-engine, sandbox, pipeline
tests/         Cross-package integration tests
demo/          AcmePay example: two specifications and a deliberately broken client
docker/        Compose file and images for web + worker
docs/          Documentation (see below)
```

## Commands

| Command | Description |
| --- | --- |
| `npm run build` | Build every package, then the web app |
| `npm run typecheck` | `tsc -b` across the project references plus the web app |
| `npm run lint` | ESLint over every package and the web app |
| `npm test` | Build packages, then run every test suite |
| `npm run ci` | lint → typecheck → test → build |
| `npm run capibara -- <args>` | Run the Capibara CLI (e.g. `analyze`, `report`, `demo`, `doctor`) |
| `npm run demo` | Run the full pipeline with in-memory providers |
| `npm run db:migrate` / `db:deploy` / `db:seed` | Prisma migrations and seed data |
| `npm run docker:up` | PostgreSQL + web + worker via Docker Compose |

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Packages, providers, request flow, pipeline stages |
| [`docs/openapi.md`](docs/openapi.md) | Canonical model, normalisation, semantic diff, security model |
| [`docs/openapi-rules.md`](docs/openapi-rules.md) | Generated catalog of every breaking-change rule |
| [`docs/environment.md`](docs/environment.md) | Every environment variable, with validation rules |
| [`docs/database.md`](docs/database.md) | Schema, constraints, migrations |
| [`docs/jobs.md`](docs/jobs.md) | Job states, atomic claiming, leases, retries |
| [`docs/worker.md`](docs/worker.md) | Startup, polling, shutdown, handlers |
| [`docs/security.md`](docs/security.md) | Controls that exist — and the gaps that remain |
| [`docs/api.md`](docs/api.md) | HTTP endpoints |
| [`docs/deployment.md`](docs/deployment.md) | Running Capibara for real |
| [`docs/cli.md`](docs/cli.md) | The `capibara` CLI: commands, exit codes, JSON mode |
| [`docs/demo-mode.md`](docs/demo-mode.md) | What is real in demo mode and what is not |
| [`docs/github-app-setup.md`](docs/github-app-setup.md) | Creating and configuring the GitHub App |

## Design commitments

* **PostgreSQL only.** No Redis, no BullMQ. Jobs are rows, claimed atomically with
  `FOR UPDATE SKIP LOCKED`.
* **Human review is mandatory.** Pull requests are drafts and the GitHub provider has
  no merge operation at all.
* **Never claim success without proof.** `PUBLISH` refuses to run unless the sandbox
  verification actually passed, and records why it was skipped.
* **Minimum context to the model.** The AI provider receives a bounded, redacted
  excerpt of one file — never a repository, never `.env`, never a key file.
* **Secrets cannot be logged.** They are wrapped in a type that refuses to stringify,
  and every log payload is redacted on the way out.
