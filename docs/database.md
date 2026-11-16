# Database

PostgreSQL is the only source of truth for durable state. Schema:
`packages/db/prisma/schema.prisma`. Migrations: `packages/db/prisma/migrations`.

## Conventions

* Every table has a primary key and `createdAt`; mutable tables also have `updatedAt`.
* Every lifecycle field is a Postgres enum, never a free-form string.
* Every foreign key is explicit and indexed.
* Uniqueness constraints exist wherever an operation must be idempotent.

## Tables

### Identity

| Table | Purpose |
| --- | --- |
| `User` | A person who signed in with GitHub OAuth. Identity only. |
| `Session` | An active sign-in. Stores only the SHA-256 of the session token. |

### Installations and repositories

| Table | Purpose |
| --- | --- |
| `Installation` | A GitHub App installation. Unique on `githubId`. |
| `Repository` | A repository Capibara manages. Unique on `githubId` and on `(owner, name)`. |
| `OpenApiSpec` | A specification document at a commit. Unique on `(repositoryId, commitSha, path)`; `contentHash` lets identical documents be skipped. |

### Analysis

| Table | Purpose |
| --- | --- |
| `AnalysisRun` | One end-to-end run. `idempotencyKey` is unique, so a redelivered webhook cannot fork a second run for the same commit range. |
| `StageRun` | One stage attempt: status, timing, error, small output summary. Unique on `(analysisRunId, stage, attempt)`. |
| `BreakingChange` | A detected change. Unique on `(analysisRunId, fingerprint)`. |
| `AffectedUsage` | A call site affected by a change. Unique on `(breakingChangeId, filePath, line, column)`. |
| `Migration` | One transformation attempt for a run, with counts and whether the AI fallback was used. |
| `Patch` | A per-file patch, its source (deterministic or AI), its diff, and content hashes for conflict detection. Unique on `(migrationId, filePath)`. |
| `ValidationResult` | The outcome of one validator against one patch. Unique on `(patchId, validator)`. |
| `SandboxRun` | A verification command: status, exit code, duration, redacted and truncated output. |
| `PullRequest` | The draft PR opened for a run. Unique per run and per `(repositoryId, number)`. `mergedAt`/`mergedBy` record a merge performed by a human, observed via webhook — Capibara never merges. |

### Infrastructure

| Table | Purpose |
| --- | --- |
| `Job` | The queue. See [`jobs.md`](jobs.md). |
| `WebhookEvent` | One delivery. Unique on `deliveryId`, which is what provides replay protection. Stores a reduced summary, never the full payload. |
| `AuditLog` | Durable audit trail. Metadata is redacted before it is written. |

## Enums

`JobStatus`, `RunStatus`, `PipelineStage`, `ChangeSeverity`, `UsageConfidence`,
`PatchSource`, `ValidationOutcome`, `PullRequestStatus`, `WebhookStatus`.

## Raw SQL

Almost everything uses Prisma. The exception is the job store, which needs
`FOR UPDATE SKIP LOCKED` — an operation with no ORM equivalent. Rather than scattering
`$queryRaw` around, those statements go through one narrow interface, `SqlClient`
(`packages/db/src/sql.ts`), which forces parameterised queries and gives a single place
to translate driver errors into `DatabaseError`.

That interface is also what makes the queue testable: the test suite runs the exact
migration SQL against an embedded PostgreSQL 16 build and exercises the real statements.

## Migrations

`packages/db/prisma/migrations/20260907000000_init/migration.sql` is applied by
`prisma migrate deploy` in production **and** by the job-store test suite against the
embedded engine. A migration that is invalid or inconsistent with the code therefore
fails in CI rather than in production.
