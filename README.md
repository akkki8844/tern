
# Tern — OpenAPI Migration Platform

Tern automatically migrates TypeScript and Node.js repositories when their OpenAPI specifications change.

## What It Does

1. **Ingests** OpenAPI 3.x specifications from GitHub pushes or uploads.
2. **Diffs** old and new specs with an oasdiff-style engine and produces deterministic migration instructions.
3. **Scans** the repository with Tree-sitter to find every affected call site, SDK method, axios instance, and generic wrapper.
4. **Migrates** code using deterministic AST transforms first, with a secure LLM fallback only when deterministic rules are insufficient.
5. **Validates** every patch against a strict security policy: no lockfiles, no secrets, no CI, no Docker, no unrelated edits.
6. **Tests** changes in an ephemeral sandbox with network isolation, secret redaction, and resource limits.
7. **Opens** a developer-quality pull request with an executive summary, diff summary, confidence score, and manual review checklist.

## Architecture

Tern is a monorepo with the following structure:

- `apps/web` — Next.js 15 dashboard and configuration UI.
- `apps/worker` — BullMQ worker that processes analysis jobs.
- `packages/openapi` — Full OpenAPI 3.x parser, normalizer, diff engine, and migration instruction generator.
- `packages/scanner` — Tree-sitter TypeScript scanner with import binding resolution, call-site classification, and benchmark tracking.
- `packages/migration-engine` — Deterministic rewrite rules, AST patch builder, patch validator, and LLM fallback.
- `packages/sandbox` — Ephemeral sandboxed test runner with timeout/memory/CPU limits and Docker support.
- `packages/github` — GitHub App integration, webhook verification, exceptional PR generation.
- `packages/llm` — Abstracted LLM adapter with optimized Fireworks integration, token trimming, and structured diff outputs.
- `packages/shared` — Config, logger, DI, security, retry, metrics, encryption, and validation utilities.
- `packages/db` — Prisma schema and client for persistence.
- `demo/` — Investor-ready AcmePay v1 → v2 migration demo.

## Quick Start

```bash
git clone https://github.com/akkki8844/tern.git
cd tern
npm run bootstrap
npm run docker:up
npm run dev
```

Open http://localhost:3000.

## Run the Demo

```bash
cd demo
bash run-demo.sh
```

## Development

```bash
npm run test
npm run typecheck
npm run lint
```

## Security

See [docs/security.md](docs/security.md).

## License

MIT
