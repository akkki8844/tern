
# Architecture

Tern is a multi-tenant GitHub App that transforms OpenAPI changes into reviewed pull requests.

## Subsystems

### OpenAPI Engine

- Loads and parses OpenAPI 3.x specs from YAML or JSON, local or remote, with size limits and path traversal protection.
- Normalizes operations, parameters, request bodies, and responses into a flat, comparable form.
- Handles circular `$ref` references safely.
- Diffs specs and produces `BreakingChange` objects with deterministic migration instructions.
- Supports endpoint removal/addition, operation ID changes, parameter renames, required parameter changes, request/response field changes, type changes, enum value changes, server changes, and security changes.

### Scanner

- Uses Tree-sitter to parse TypeScript and JavaScript with graceful fallback when native modules are unavailable.
- Falls back to regex-based scanning when tree-sitter is unavailable.
- Resolves import bindings including default, namespace, named, and renamed imports.
- Classifies call sites: fetch, axios, axios instances, SDK imports, SDK methods, and generic HTTP helpers.
- Extracts surrounding identifiers, destructured fields, object spreads, optional chains, nested member access, and async wrapper contexts.
- Matches call sites to breaking changes using a weighted scoring system.
- Tracks benchmark metrics: files scanned, lines parsed, call sites found, matches, and duration.

### Migration Engine

- Applies deterministic rewrite rules based on migration instructions.
- Rules cover field renames, method renames, parameter renames, endpoint moves, server URL changes, required parameter additions, enum value removals, type changes, and endpoint removals.
- LLM fallback only used for high/medium confidence usages when no deterministic rule applies.
- Generates proper LCS-based unified diff output with hunk headers.
- Validates every patch with the patch validator.
- Tracks stats: rules applied, LLM invocations, and failed rules.

### Patch Validator

- Rejects forbidden file paths and extensions.
- Rejects patches containing secrets, eval, new Function, child_process, spawn, exec, or unsafe imports.
- Rejects patches that are too large or modify too much of a file.
- Warns on unrelated edits and suspicious additions.

### Sandbox

- Creates an ephemeral workspace copy of the repository.
- Runs `npm ci --ignore-scripts` to install dependencies without running post-install scripts.
- Runs the project test command with configurable timeout, memory, and CPU limits.
- Splits command strings into executable and arguments for proper process spawning.
- Sanitizes environment variables and redacts secrets in output.
- Cleans up the workspace after the run, including on partial failure.

### GitHub App

- Verifies webhook HMAC signatures with constant-time comparison.
- Creates installation tokens, lists repositories, and reads commit metadata.
- Creates branches, commits, and pull requests.
- Generates exceptional PR bodies with executive summaries, API diff tables, affected call site tables, migration reasoning, confidence scores, test results, warnings, and manual review checklists.
- Uses factory pattern to create appropriate service (mock or real) based on configuration.

### LLM Adapter

- Abstracted interface supporting any provider.
- Fireworks adapter with token trimming, retry logic, structured JSON outputs, and token accounting.
- Validates structured diffs: no duplicate entries, no no-op changes.
- Mock adapter for offline development and deterministic tests.

### Web Dashboard

- Next.js 15 App Router with Tailwind CSS and shadcn/ui design system.
- Sidebar navigation with icons, theme support (light/dark/system), skip link for accessibility.
- Consistent component library: Button, Card, Input, Label, Badge, Skeleton, PageShell.
- Pipeline status visualization for analysis progress tracking.
- Polished empty, loading, error, and skeleton states.

### Shared Utilities

- Configuration management, structured logging with pino, dependency injection, retry, metrics, encryption, secret redaction, validation, health checks, and rate limiting.

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
