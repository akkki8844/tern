# Turn 1 — Core runtime: engineering report

**Scope delivered:** configuration, persistence, job system, worker runtime, pipeline
orchestrator, provider abstractions, GitHub App auth + webhooks + OAuth, AI provider,
workspaces, logging, error model, security fixes, tests, CI, documentation, demo mode.

**Not attempted (correctly out of scope for Turn 1):** dashboard data wiring, CLI,
scanner/rule precision tuning, billing, teams, SSO, notifications, analytics.

---

## 1. Starting state — audit findings

The repository **did not install**. `npm install` failed with `ERESOLVE`: the root
declared `tree-sitter@^0.22.4` while `tree-sitter-typescript@0.23.2` requires
`tree-sitter@^0.21`. Nothing downstream — build, typecheck, test, CI — had ever run.
Everything below was discovered by reading the code, then confirmed by running it.

| Area | Verdict | Evidence |
| --- | --- | --- |
| Dependency graph | **Broken** | Install failed; workspace packages also listed as `file:` deps of the root |
| Prisma schema | **Partial** | Lowercase string job statuses, no lease/heartbeat/cancel, no migrations directory at all, no User/Session/WebhookEvent/ValidationResult |
| `pg-queue.ts` | **Racy** | `findMany` + `updateMany` claiming, no stale recovery, retry read a stale `attempts`, `setInterval` poll with no overlap guard |
| Worker `index.ts` | **Fragile** | Signal handlers called `process.exit(0)` with work in flight; no DB verification at boot |
| `orchestrator.ts` | **Broken** | One `run()` method, no stages, `repoPath` hardcoded to `demo/broken-app`, imported `prisma` but persisted nothing, opened a PR without gating on the sandbox result |
| `config.ts` | **Unsafe** | No validation; `DATABASE_URL` silently defaulted to `postgresql://localhost:5432/capibara`; GitHub secrets defaulted to `""`; `NODE_ENV as any` |
| `github-service.ts` | **Vulnerable** | `verifyWebhook` compared signatures with `===`; `createGitHubService()` silently fell back to a mock when credentials were absent |
| `mock-github-service.ts` | **Nonsense** | `crypto.subtle ? a === b : a === b` |
| `fireworks-adapter.ts` | **Incomplete** | No timeout, no `Retry-After`, no schema validation, raw response bodies embedded in error messages |
| `sandbox.ts` | **Buggy + unsafe** | `mkdtemp(opts.workingDir)` treats the argument as a *prefix*, so cleanup deleted the wrong path (temp-dir leak); `command.split(/\s+/)`; Docker runner mounted `:ro` then ran `npm ci`, and passed `sh -c command` |
| Web webhook route | **Fake** | Verified the signature, then returned — no persistence, no enqueue |
| Web analyze route | **Fake** | Returned `analysis-${Date.now()}` with no database write |
| Health endpoints | **Fake** | Hardcoded `"healthy"` |
| `apps/web` | **Broken** | Duplicate `app/` and `src/app/` trees; Tailwind v4 PostCSS plugin with a v3 config and no such dependency |
| OAuth | **Missing** | No code existed, despite `docker-compose.yml` passing `GITHUB_CLIENT_ID`/`SECRET` |
| Error model | **Missing** | Three error classes existed of the required twelve |
| Scanner tests | **Empty** | `call-site-extractor.test.ts` and `import-resolver.test.ts` contained no assertions, only `// Skipped: requires tree-sitter` |
| `tests/` | **Never ran** | Not a workspace; its scripts pointed at paths that did not exist |
| Docs | **Wrong** | Described Redis/BullMQ, health checks and PR gating that did not exist |

### Preserved because it was good

`packages/openapi` (loader, normaliser, diff engine), `packages/scanner`'s matcher and
call-site model, `packages/migration-engine`'s rule table / validator / LCS diff, the
sandbox's `shell: false` + output-truncation instincts, and `pr-report.ts`. These were
kept and adapted rather than rewritten.

---

## 2. What changed

### Build and dependency graph
- Resolved the `ERESOLVE` conflict by aligning on `tree-sitter@^0.21.1` and removing the
  dependency from the four packages that never imported it.
- Removed the workspace `file:` self-references from the root `package.json`.
- Replaced per-package `baseUrl`/`paths` compilation — which recompiled every dependency's
  sources into each package's `dist`, duplicating code and breaking `instanceof` across
  copies — with **TypeScript project references**. Build order is now enforced by `tsc -b`
  and a dependency cycle is a compile error.
- Deleted the duplicate `apps/web/src/` app tree that shadowed `apps/web/app/`.
- Pinned Tailwind to v3 to match the existing config, and removed the `next/font/google`
  dependency that made `next build` fail whenever Google Fonts was unreachable.
- Committed `package-lock.json` and switched CI to `npm ci`.

### 1. Configuration
`packages/shared/src/config.ts` is now the only module permitted to read `process.env`,
enforced by an ESLint `no-restricted-syntax` rule that fails the build. Everything is
parsed with zod; **all** problems are reported at once with actionable messages. Secrets
are wrapped in a `Secret` type whose `toString`, `toJSON`, `Symbol.toPrimitive` and
`util.inspect` hooks all return `[REDACTED]`; the value is reachable only through an
explicit, greppable `.reveal()`. `loadConfig` takes an environment argument, so it is
unit-tested rather than eyeballed.

### 2. Database
Rewritten schema with 17 tables and 9 enums covering every required model plus `Session`,
`StageRun` and `WebhookEvent`. Added the **first migration the project has ever had**.
That same SQL is applied by the job-store test suite against an embedded PostgreSQL, so a
migration inconsistent with the code fails CI rather than production.

### 3. Job system (`packages/jobs`)
PostgreSQL only. Claiming is a single statement — a `FOR UPDATE SKIP LOCKED` CTE that
selects candidates and flips them to `RUNNING` atomically. All timestamps come from the
database, so worker clock skew cannot corrupt scheduling or lease expiry. Leases,
heartbeats, crash reclamation, cancellation, `ON CONFLICT`-based idempotency keys, and
exponential backoff with jitter.

The store talks to a narrow `SqlClient` interface rather than Prisma directly. That is
not gratuitous abstraction: `FOR UPDATE SKIP LOCKED` has no ORM equivalent, and the
seam is what allows the queue to be tested against a real PostgreSQL engine.

### 4. Worker runtime
Verifies configuration, then the database connection, then reaps orphaned workspaces,
then recovers jobs abandoned by crashed workers — before claiming anything. Bounded
concurrency, jittered polling that wakes on shutdown, per-job `AbortController`, lease
renewal, abort on lease loss (this is what prevents duplicate execution), abort on
cancellation, and a `SIGTERM` drain that waits for in-flight work and requeues whatever
cannot finish.

### 5. Pipeline orchestrator
Eight discrete stages, each `Stage<TInput, TOutput>` so the output of one is the input of
the next and a stage cannot consume data that was never produced. `runStage` centralises
timing, correlation-scoped logging, `StageRun` persistence, and translation of any thrown
value into a `PipelineError` that names the failing stage and preserves the underlying
`retryable` flag. Failures stop the pipeline.

### 6. Providers
`GitHubProvider`, `AIProvider`, `RepositoryProvider`, `WorkspaceProvider`,
`StorageProvider` are declared in `packages/shared/src/providers.ts` with no vendor types.
Implementation selection happens once, in `apps/worker/src/runtime.ts`; nothing downstream
branches on `demoMode`.

### 7. Fireworks provider
Real HTTP client with `AbortController` timeout, retry with backoff that honours
`Retry-After`, 4xx-not-retried classification, zod validation of both the envelope and
the JSON payload, and structural rejection of edits whose `search` text is absent from
the excerpt. It returns **search/replace edits**, not a rewritten file — the previous
design asked the model for the whole file back, which is unbounded and unreviewable.

### 8. GitHub App auth
App JWT → installation tokens via `@octokit/auth-app`, cached in memory below their
lifetime, never persisted or logged. Owner/repo/branch/sha validated before any network
call. No PAT support anywhere. **No merge or approve method exists**, and a test asserts
the method surface stays that way.

### 9. Webhooks
Signature verified over the raw bytes in constant time **before** anything is parsed,
stored or logged. Malformed → 400, forged → 401. Duplicates suppressed by a unique index
on `deliveryId` (a database constraint, not a cache a restart would defeat). A reduced,
non-sensitive summary is persisted, a job is enqueued, and 202 is returned. No pipeline
work runs inline.

### 10. OAuth
`read:user` only, kept entirely separate from App auth. Random per-attempt `state` in a
short-lived HttpOnly cookie, compared in constant time. The user token is used once to
read the profile and discarded. Sessions store only the SHA-256 of the cookie value.
Sign-out is POST-only.

### 11. Workspaces
One generated directory per job under a single root, mode `0700`. Every derived path goes
through `resolveWithin`. Disposal is idempotent, refuses to delete outside the root, and
runs on success, failure and cancellation via `withWorkspace`'s `finally`. Orphans are
reaped by age at startup.

### 12–13. Logging and errors
Structured pino output; **all** context passes through a redactor that works by key name
*and* by credential pattern, truncates long strings, and handles cycles. Full 12-class
error taxonomy plus `WorkspaceError`/`PipelineError`/`InternalError`, each with a stable
code, a `retryable` hint, internal `details`, and a `toPublicJSON()` that never emits a
stack trace.

---

## 3. Security audit and fixes

| Finding | Severity | Fix |
| --- | --- | --- |
| Webhook signature compared with `===` | **Critical** | Constant-time compare over hashed inputs; strict `sha256=` + 64-hex-char validation |
| No webhook replay/duplicate protection | High | Unique index on `WebhookEvent.deliveryId` |
| `createGitHubService()` silently fell back to a mock without credentials | High | Removed; missing credentials outside demo mode are now a `ConfigurationError` |
| Docker sandbox ran `sh -c <command>` | High | Runner removed rather than left injection-prone; documented as deferred |
| `command.split(/\s+/)` built argv from a string | High | Commands are explicit `{ command, args }` pairs; the executable name is strictly validated |
| Sandbox inherited `process.env` and redacted by deny-list | High | Rebuilt from an **allowlist**; a test asserts an unrelated secret is invisible to the child |
| `npm install` could run repository lifecycle scripts | High | `npm_config_ignore_scripts=true` in the sandbox environment |
| `mkdtemp(opts.workingDir)` used the argument as a prefix; cleanup deleted the wrong path | High | Workspace provider owns creation and disposal; traversal-proof; leak test added |
| Fireworks error messages embedded raw response bodies | High | Bodies redacted and truncated; a test asserts an echoed API key never reaches the error |
| AI fallback returned a whole rewritten file | High | Bounded excerpt in, verbatim search/replace edits out, hallucinations dropped, validator unchanged |
| No guard against sending `.env`/keys to the model | High | `buildMigrationContext` refuses forbidden paths, non-source files, and any excerpt where a credential survives redaction |
| `DATABASE_URL` and webhook secrets silently defaulted | High | Fail-fast validation |
| Security headers excluded `/api` | Medium | Matcher fixed; CSP, COOP added |
| Timeouts killed only the process leader | Medium | SIGTERM → SIGKILL against the process group |
| Unbounded subprocess output | Medium | 50 KB per stream, truncated and redacted |
| Git clone would have put the token in argv/URL | Medium | `0600` credential file outside the checkout, referenced via `credential.helper`, removed in `finally`; `.git` deleted after checkout |
| Audit log was in-memory only | Medium | Durable `AuditLog` table; metadata redacted before writing |
| PR could be opened without verification | Medium | `PUBLISH` gates on a passing sandbox report and records the skip reason |

Non-security bugs found and fixed while testing: the scanner's glob compiled `**/*.ts`
into a regex that **required** a directory separator, so root-level files were never
scanned; and namespace imports (`import * as x`) were silently dropped because
`childForFieldName("name")` always returned `undefined` on that node.

---

## 4. Tests

**304 tests, 0 failures.** Behaviour, not coverage padding.

| Suite | Tests | Notable coverage |
| --- | --- | --- |
| `@capibara/shared` | 77 | Config validation and aggregation, PEM normalisation, secret non-leakage, redaction patterns, logger redaction, path traversal, argv and branch-name validation |
| `@capibara/db` | 5 | Migration completeness, uniqueness constraints, transient-error classification |
| `@capibara/jobs` | 26 | Real PostgreSQL: single-claim, priority, lease expiry recovery, retry backoff, attempt exhaustion, non-retryable failure, cancellation, heartbeat renewal, error-detail redaction |
| `@capibara/workspace` | 10 | Isolation between workspaces, traversal on read/write/resolve, disposal on throw, orphan reaping, `0700` permissions |
| `@capibara/github` | 35 | Valid/invalid/tampered/sha1/malformed signatures, payload validation, delivery-id validation, provider selection, no-merge-surface assertion |
| `@capibara/llm` | 27 | Timeout, external abort, 5xx retry, `Retry-After`, 401 not retried, malformed envelope/JSON/schema, hallucination filtering, key never in errors, context-builder refusals |
| `@capibara/openapi` | 14 | Existing diff/normaliser suites (preserved) |
| `@capibara/scanner` | 28 | Real tree-sitter parsing, imports, aliases, namespaces, call-site positions, demo-fixture matching |
| `@capibara/migration-engine` | 33 | Deterministic rules, AI-fallback gating by confidence, validator rejections |
| `@capibara/sandbox` | 13 | No-shell proof, timeout kill, output bounds, output redaction, environment allowlist, refusal to verify without a manifest |
| `@capibara/pipeline` | 10 | Stage timing/persistence, failure translation, retryable preservation, cancellation, real `git clone`, credential-file cleanup |
| `@capibara/tests` | 11 | Cross-package integration + security regressions |
| `@capibara/worker` | 15 | Two workers never run one job, concurrency cap, retry, startup recovery, abort on lease theft, abort on cancel, lease renewal, graceful drain, forced-shutdown requeue, survival of a store failure |

### Honest limitations

- **The job-store suite runs against PGlite** — a real PostgreSQL 16 build compiled to
  WebAssembly, executing the project's real migration SQL. It is a real database, but a
  single-backend one, so it cannot prove behaviour under *simultaneous* connections.
  The multi-connection test (`concurrency.test.ts`) needs a real server and runs only
  when `CAPIBARA_TEST_DATABASE_URL` is set. CI sets it. **In this sandbox it is skipped
  with an explicit reason** — outbound network is restricted to the npm registry, so no
  PostgreSQL server could be installed. I have not observed that test pass.
- **`prisma generate` could not run here** for the same reason (`binaries.prisma.sh` is
  unreachable). Locally, `@prisma/client` resolves to its ungenerated stub, which types
  `PrismaClient` as `any`. So the Prisma-typed code in the worker handlers and web routes
  compiles locally but is **only fully type-checked in CI**, after generation. I kept
  those call sites deliberately plain and matched them field-by-field against the schema,
  but this is the one part of the change I could not verify by execution.
- **No live GitHub or Fireworks calls were made.** Both providers are tested against
  injected `fetch` implementations and by input validation that runs before any network
  I/O. Their behaviour against the real services is unverified.

---

## 5. Build and CI status

Run locally, in this order, from a clean tree:

| Step | Result |
| --- | --- |
| `npm install` | Succeeds (the `postinstall` `prisma generate` fails here only because the engine download host is unreachable) |
| `npm run lint` | Clean — 0 errors, 7 pre-existing `no-explicit-any` warnings in `openapi`/`scanner` |
| `npm run typecheck` | Clean |
| `npm run test` | 304 passed, 0 failed |
| `npm run build` | Packages + Next.js production build succeed |
| `npm run demo` | Full 8-stage pipeline runs end to end |

`.github/workflows/ci.yml` now runs against a PostgreSQL 16 service container, applies
migrations with `prisma migrate deploy`, sets `CAPIBARA_TEST_DATABASE_URL` so the concurrency
suite actually executes, and finishes by running the demo as a smoke test.

### Demo output (real, from this machine)

```
DISCOVER:SUCCEEDED DIFF:SUCCEEDED SCAN:SUCCEEDED PLAN:SUCCEEDED
MIGRATE:SUCCEEDED VALIDATE:SUCCEEDED TEST:SUCCEEDED PUBLISH:SUCCEEDED
publish: verification failed at the "test" step
```

6 breaking changes, 19 affected call sites via tree-sitter, 3 validated patches, real
`npm install` + `npm test` in the sandbox — and **no pull request**, because the tests
did not pass. That is the system behaving correctly, not a failure.

---

## 6. Decisions and trade-offs

1. **PGlite for job-store tests.** The alternative was mocking the queue, which would
   have tested nothing: the value of `FOR UPDATE SKIP LOCKED` is entirely in what
   PostgreSQL does with it. An embedded real engine tests the actual SQL.
2. **A `SqlClient` seam instead of raw `$queryRaw` everywhere.** One small interface,
   introduced because raw SQL was genuinely required, that also makes the critical path
   testable. Everything else uses Prisma normally.
3. **TypeScript project references.** The `paths`-based setup compiled each dependency's
   source into every consumer's `dist`. References fix correctness, not just tidiness.
4. **Removed the Docker sandbox runner** rather than leaving `sh -c` in the tree. A
   container boundary is the right answer and is documented as deferred; a broken one is
   worse than an honest gap.
5. **Untyped errors are retried, typed ones obey their own flag.** A `ConfigurationError`
   will never succeed on retry; an unexpected exception often will. `maxAttempts` bounds
   both.
6. **Deleted `scripts/verify-final.py`.** It asserted that directories exist — precisely
   the kind of "verification" that proves nothing.
7. **Replaced `demo/run-demo.ts`** (which no longer parsed) with `apps/worker/src/demo.ts`,
   a separate entrypoint that runs the real pipeline. Demo mode is preserved and is now
   stronger; it also runs in CI.

---

## 7. Deferred, with reasons

| Item | Why |
| --- | --- |
| Container/VM sandbox isolation | Needs a runtime boundary and infrastructure decisions; the current sandbox is honest about being process-level |
| Dashboard wired to live data | Turn 1 is the runtime; the UI is still the original static shell |
| CLI | The product is described as CLI-first, but no CLI existed and it is not core-runtime scope |
| Persisting per-stage domain rows (breaking changes, usages, patches) | The pipeline produces them and `StageRun` records each stage; fanning them into their tables belongs with the UI that reads them |
| Scanner/rule precision | Deliberately untouched beyond two outright bugs |
| Per-repository authorisation on dashboard routes | Sessions identify a user; scoping needs the dashboard work |
| Distributed rate limiting | Per-process limiter is adequate for the current single-endpoint threat |
| `ENCRYPTION_KEY` usage | Nothing sensitive is stored at rest yet; the primitive exists so future storage does not invent its own |
