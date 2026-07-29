
# Tern

Tern is a GitHub App that automatically detects breaking OpenAPI changes and generates safe, tested migration patches for TypeScript/Node.js repositories.

## Core Workflow

1. Install the GitHub App on a repository.
2. Provide the OpenAPI spec for the API you depend on.
3. Tern detects breaking changes between old and new specs.
4. Tern scans your repository for affected code usages.
5. Tern generates deterministic migration patches.
6. Tern validates patches for security and correctness.
7. Tern runs tests in an isolated sandbox.
8. Tern opens a GitHub Pull Request for human review.

## Workspace

- `apps/web` — Next.js 15 dashboard
- `apps/worker` — BullMQ background worker
- `packages/shared` — Config, logging, DI, types, security utilities
- `packages/db` — Prisma + PostgreSQL
- `packages/github` — GitHub App abstraction
- `packages/openapi` — OpenAPI parser, validator, diff engine
- `packages/scanner` — Tree-sitter code analysis
- `packages/migration-engine` — Deterministic migration + LLM fallback
- `packages/sandbox` — Ephemeral test runner
- `packages/llm` — Fireworks AI adapter

## Quick Start

```bash
npm run bootstrap
npm run docker:up
npm run dev
```

## Demo Mode

Set `DEMO_MODE=true` to run without real GitHub credentials.

## License

MIT
