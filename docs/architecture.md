
# Architecture

Tern is a multi-tenant GitHub App that transforms OpenAPI changes into reviewed pull requests.

## Subsystems

### 1. OpenAPI Engine (`packages/openapi`)

- Loads and parses OpenAPI 3.x specs from YAML or JSON, local or remote, with size limits.
- Normalizes operations, parameters, request bodies, and responses into a flat, comparable form.
- Diffs old and new specs and produces `BreakingChange` objects with severity and migration instructions.
- Supports endpoint removal/addition, method changes, operationId changes, parameter renames, required parameter changes, request/response field changes, type changes, enum value changes, server changes, and security changes.

### 2. Scanner (`packages/scanner`)

- Uses Tree-sitter to parse TypeScript and JavaScript.
- Resolves import bindings including default, namespace, named, and renamed imports.
- Classifies call sites: fetch, axios, axios instances, SDK imports, SDK methods, and generic HTTP helpers.
- Extracts surrounding identifiers, destructured fields, object spreads, optional chains, and generic wrapper contexts.
- Matches call sites to breaking changes using a weighted scoring system.
- Tracks benchmark metrics: files scanned, lines parsed, call sites found, matches, and duration.

### 3. Migration Engine (`packages/migration-engine`)

- Applies deterministic rewrite rules based on migration instructions.
- Rules cover field renames, method renames, parameter renames, endpoint moves, and server URL changes.
- Falls back to the LLM adapter only when no deterministic rule applies.
- Validates every patch with the patch validator.
- Tracks stats: rules applied, LLM invocations, and failed rules.

### 4. Patch Validator (`packages/migration-engine`)

- Rejects forbidden file paths and extensions.
- Rejects patches containing secrets, eval, new Function, child_process, spawn, exec, or unsafe imports.
- Rejects patches that are too large or modify too much of a file.
- Warns on unrelated edits and suspicious additions.

### 5. Sandbox (`packages/sandbox`)

- Creates an ephemeral workspace copy of the repository.
- Runs `npm ci --ignore-scripts` to install dependencies without running post-install scripts.
- Runs the project test command with configurable timeout, memory, and CPU limits.
- Sanitizes environment variables and redacts secrets in output.
- Cleans up the workspace after the run.

### 6. GitHub App (`packages/github`)

- Verifies webhook HMAC signatures with constant-time comparison.
- Creates installation tokens, lists repositories, and reads commit metadata.
- Creates branches, commits, and pull requests.
- Generates exceptional PR bodies with executive summaries, API diff tables, affected files, migration reasoning, confidence scores, test results, warnings, and manual review checklists.

### 7. LLM Adapter (`packages/llm`)

- Abstracted interface supporting any provider.
- Fireworks adapter with token trimming, retry logic, structured JSON outputs, and token accounting.
- Mock adapter for offline development and deterministic tests.

### 8. Web Dashboard (`apps/web`)

- Next.js 15 App Router with Tailwind CSS and shadcn/ui-inspired components.
- Responsive layout, dark mode, accessible navigation, and polished empty/loading/error states.

### 9. Worker Pipeline (`apps/worker`)

- BullMQ-based queue for analysis jobs.
- Orchestrates diff, scan, migrate, validate, sandbox, and PR creation.
- Records audit logs and metrics.

### 10. Shared Utilities (`packages/shared`)

- Configuration management, structured logging, dependency injection, retry, metrics, encryption, secret redaction, validation, and security primitives.

## Data Flow

1. GitHub push event triggers webhook.
2. Webhook handler validates signature and enqueues analysis job.
3. Worker loads old and new OpenAPI specs.
4. OpenAPI engine diffs specs and generates migration instructions.
5. Scanner finds affected call sites.
6. Migration engine applies deterministic rules and LLM fallback.
7. Patch validator rejects unsafe patches.
8. Sandbox tests the migrated code.
9. GitHub service creates a branch, commit, and pull request.
10. Dashboard displays progress and results.

## Scalability

- Worker queue is horizontally scalable.
- Sandbox runs are isolated and ephemeral.
- Scanner processes files concurrently with size limits.
- LLM calls are token-trimmed and retried.
