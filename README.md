
# Tern — OpenAPI Migration Platform

Tern automatically migrates TypeScript and Node.js repositories when their OpenAPI specifications change.

## What It Does

1. **Ingests** OpenAPI 3.x specs from GitHub pushes, uploads, or URLs.
2. **Diffs** old and new specs with a full OpenAPI 3.x engine, producing deterministic migration instructions.
3. **Scans** the repository with Tree-sitter to find every affected call site, including alias imports, optional chains, destructured fields, async wrappers, and typed SDK clients.
4. **Migrates** code using deterministic AST transforms first. A secure LLM fallback is used only when deterministic rules are insufficient.
5. **Validates** every patch against a strict security policy: no lockfiles, no secrets, no CI, no Docker, no unrelated edits.
6. **Tests** changes in an ephemeral sandbox with network isolation, secret redaction, and resource limits.
7. **Opens** a senior-engineer-quality pull request with an executive summary, API diff table, affected call sites, migration reasoning, confidence score, and manual review checklist.

## Architecture

- `apps/web` — Next.js 15 dashboard with sidebar navigation, theme support, shadcn/ui design system, and pipeline visualization.
- `apps/worker` — BullMQ worker that orchestrates the full analysis pipeline.
- `packages/openapi` — Full OpenAPI 3.x parser, normalizer, diff engine, migration instruction generator.
- `packages/scanner` — Tree-sitter TypeScript scanner with graceful native-module fallback, import resolution, call-site classification, and benchmark tracking.
- `packages/migration-engine` — Deterministic rewrite rules, AST patch builder, patch validator, and LLM fallback.
- `packages/sandbox` — Ephemeral sandboxed test runner with timeout/memory/CPU limits, secret redaction, and Docker support.
- `packages/github` — GitHub App integration, webhook verification, exceptional PR generation with explainability.
- `packages/llm` — Abstracted LLM adapter with optimized Fireworks integration, token trimming, structured diff validation.
- `packages/shared` — Config, logger, DI, security, retry, metrics, encryption, validation.
- `packages/db` — Prisma schema and client.
- `demo/` — Investor-ready AcmePay v1 → v2 migration demo.

## Quick Start

```bash
git clone https://github.com/akkki8844/tern.git
cd tern
npm install
npm run docker:up
npm run dev
```

Open http://localhost:3000.

## Run the Demo

```bash
cd demo
npm run demo
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
