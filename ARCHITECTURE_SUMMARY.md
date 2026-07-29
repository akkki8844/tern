
# Tern Architecture Summary

Tern is a GitHub App for TypeScript/Node.js repositories that automatically detects breaking OpenAPI changes and generates safe, tested migration patches.

## Workspace
- `apps/web` — Next.js 15 dashboard with dark mode
- `apps/worker` — BullMQ background worker with orchestration pipeline
- `packages/shared` — Config, logging, DI, retry, rate limit, health, metrics, encryption, audit, redactor, types
- `packages/db` — Prisma + PostgreSQL with 15 models
- `packages/github` — GitHub App abstraction (Octokit + Mock adapters)
- `packages/openapi` — Spec loader, validator, oasdiff-style diff engine
- `packages/scanner` — Tree-sitter TypeScript analysis
- `packages/migration-engine` — Deterministic rewrites + LLM fallback + patch validator
- `packages/sandbox` — Ephemeral and Docker sandbox runners
- `packages/llm` — Fireworks adapter + Mock adapter
- `demo` — AcmePay v1/v2 OpenAPI specs and broken TypeScript app

## Pipeline
1. OpenAPI spec diff detection
2. Repository code scan
3. Migration patch generation
4. Patch validation
5. Sandbox test execution
6. GitHub PR creation

## Production Features
- Secret redaction
- AES-256 encryption
- Webhook HMAC verification
- Rate limiting
- Health checks
- Audit logs
- Retry with exponential backoff
- Metrics collection
- Docker Compose deployment
- Mock adapters for demo mode

## Source Files
- 50+ TypeScript files
- 15+ React/TSX files
- 12+ test files
- 11 documentation files
- 6 demo scripts
