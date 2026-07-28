# Tern Architecture (Private Alpha)

Tern runs with a deterministic-first pipeline:

1. Ingest OpenAPI specs.
2. Detect explicit breaking changes.
3. Scan TypeScript code usage with Tree-sitter.
4. Generate deterministic patches first.
5. Validate patches against strict safety rules.
6. Run install/tests in isolated sandbox.
7. Open human-reviewed GitHub PR.

Core runtime modes:

- Demo mode: local workflow with no credentials.
- Production mode: real GitHub App + Redis + Postgres + worker queues.
