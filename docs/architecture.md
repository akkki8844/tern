# Architecture

Capibara turns an OpenAPI change into a reviewed pull request. This document describes what
exists today — core runtime, semantic diff engine, repository-intelligence scanner, migration engine and dashboard — not what is planned.

## Packages

```
packages/
  shared/            configuration, errors, logging, redaction, security, provider interfaces
  db/                Prisma schema + migrations, client, SQL boundary, audit log
  jobs/              PostgreSQL job store (claim/heartbeat/retry/recover)
  workspace/         isolated per-job filesystem workspaces
  github/            GitHub App provider, demo provider, webhook verification
  llm/               Fireworks AI provider, demo/disabled providers, prompt context builder
  openapi/           canonical model, normalisation, semantic diff, rule catalog
  scanner/           tree-sitter call-site extraction and matching
  migration-engine/  deterministic rules, AI fallback, patch validation, diffing
  sandbox/           argv-only process execution, install/build/test verification
  pipeline/          stage abstraction, the eight stages, repository checkout providers
apps/
  worker/            worker runtime, job handlers, demo entrypoint
  web/               dashboard, webhook endpoint, OAuth, health checks
tests/               cross-package integration tests
```

The dependency graph is enforced by TypeScript project references
(`tsconfig.build.json`), so `tsc -b` builds packages in the correct order and a cycle
is a compile error.

## Provider abstractions

The pipeline depends only on interfaces declared in `packages/shared/src/providers.ts`:

| Interface | Real implementation | Demo/alternate |
| --- | --- | --- |
| `GitHubProvider` | `GitHubAppProvider` (Octokit + App auth) | `DemoGitHubProvider` (in memory) |
| `AIProvider` | `FireworksAIProvider` | `DemoAIProvider`, `DisabledAIProvider` |
| `RepositoryProvider` | `GitRepositoryProvider` (git clone) | `LocalRepositoryProvider` (copy) |
| `WorkspaceProvider` | `FilesystemWorkspaceProvider` | — |
| `StorageProvider` | *(declared, not yet needed — workspaces are ephemeral by design)* | — |

Selection happens once, in `apps/worker/src/runtime.ts`. Nothing downstream inspects
`config.demoMode` to change behaviour; it receives providers.

## Request flow

```
GitHub push
   │
   ▼
POST /api/webhooks/github        (apps/web)
   │  verify HMAC signature over the raw body
   │  reject malformed (400) / forged (401)
   │  de-duplicate on X-GitHub-Delivery (unique index)
   │  persist a reduced summary, enqueue a job, return 202
   ▼
Job: webhook.process             (apps/worker)
   │  resolve the repository, ignore non-default branches
   │  upsert an AnalysisRun keyed by (repo, base, head)
   │  enqueue analysis.run
   ▼
Job: analysis.run                (apps/worker + packages/pipeline)
   │
   └── DISCOVER → DIFF → SCAN → PLAN → MIGRATE → VALIDATE → TEST → PUBLISH
```

## Pipeline stages

Each stage is a `Stage<TInput, TOutput>`: the output of one is the input of the next, so
a stage cannot consume data that has not been produced. `runStage` provides timing,
structured logging bound to a correlation id, persistence of a `StageRun` row, and
translation of any thrown value into a `PipelineError` that names the failing stage.
A failure stops the pipeline; nothing continues past a broken stage.

| Stage | Input | Output | Notes |
| --- | --- | --- | --- |
| `DISCOVER` | repository + refs | checkout path, spec path, base/head spec text | Checks out head into a workspace, locates the OpenAPI document |
| `DIFF` | both specs | breaking changes + full semantic analysis | Rule-based classification with direction and confidence; see [`openapi.md`](openapi.md) |
| `SCAN` | checkout + changes | affected usages | tree-sitter; falls back to regex with a warning |
| `PLAN` | usages | target files, skipped files | Drops sensitive paths and the spec itself |
| `MIGRATE` | plan | patches | Deterministic rules first, bounded AI fallback second |
| `VALIDATE` | patches | valid / rejected | Every patch is re-validated before it can reach a commit |
| `TEST` | valid patches | verification report | Writes patches into the workspace, runs install → build → test |
| `PUBLISH` | verified patches | pull request or a skip reason | Refuses to publish unless verification actually passed |

## Publishing rules

* `PUBLISH` runs only when there is at least one valid patch **and** the sandbox
  verification passed. Otherwise it records a skip reason and finishes successfully.
* Pull requests are always opened as **drafts**.
* `GitHubProvider` exposes no merge and no approve operation. Capibara cannot merge, by
  construction, and a test asserts that the method surface stays that way.

## Persistence

PostgreSQL is the source of truth for everything durable: users and sessions,
installations and repositories, specifications, analysis runs and per-stage records,
breaking changes, affected usages, migrations, patches, validation results, sandbox
runs, pull requests, jobs, webhook deliveries and the audit log. See
[`docs/database.md`](database.md).

## Observability

Every log line is structured JSON and carries `service`, `component` and whatever
context the caller bound — typically `jobId`, `analysisRunId`, `stage` and
`correlationId`. All context is passed through a redactor before it reaches the
transport, so a credential cannot be logged even if it arrives from repository content
or a provider response.
