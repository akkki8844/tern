# Tern MVP

Tern is a narrow GitHub App MVP for TypeScript/Node.js repositories that detects OpenAPI 3.x breaking changes, finds impacted usages, prepares deterministic migrations, validates patches, runs tests in isolation, and opens a migration PR for human review.

## Architecture plan
1. **Ingestion + Auth**: GitHub App install + signed webhook verification + installation-scoped tokens.
2. **Analysis pipeline**: OpenAPI diff normalization → Tree-sitter usage scan → deterministic patch generation → strict patch validation.
3. **Execution pipeline**: sandbox worker clone at fixed SHA → install/test with timeouts/redaction → PR composition.
4. **UX + Audit**: dark dashboard, analysis report, patch preview, PR history, settings disconnect, audit log.

## Database schema
Defined in `/home/runner/work/tern/tern/prisma/schema.prisma` with the required models:
- User
- Organization
- GitHubInstallation
- Repository
- ApiSpecPair
- AnalysisRun
- BreakingChange
- AffectedUsage
- MigrationPatch
- PullRequest
- AuditLog

## File tree (high level)
- `app/` Next.js App Router pages and API routes
- `lib/openapi/` breaking diff normalization
- `lib/scanner/` Tree-sitter TypeScript usage scanner
- `lib/migration/` deterministic migration + patch validator
- `lib/security/` secret redaction helpers
- `lib/github/` webhook verification + PR body generation
- `lib/demo/` AcmePay seeded demo flow
- `prisma/` schema
- `demo/acmepay-repo/` seeded broken TypeScript Express-style sample and specs
- `tests/` unit and integration tests

## Implementation phases
1. Scaffold app + core infrastructure (done)
2. Implement OpenAPI diffing, scanning, migration, validation, redaction (done)
3. Add dashboard + demo analysis/patch/PR flow and API routes (done)
4. Add tests and local deployment docs (done)

## Environment variables
Create `.env.local`:

```bash
DATABASE_URL=******localhost:5432/tern
REDIS_URL=redis://localhost:6379
GITHUB_WEBHOOK_SECRET=replace_me
GITHUB_APP_ID=replace_me
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
LLM_PROVIDER=openai
OPENAI_API_KEY=replace_me
```

## Local setup
```bash
npm install
npm run db:generate
npm run dev
```
Open `http://localhost:3000`.

## Docker Compose
```bash
docker compose up --build
```

## Demo mode (no GitHub credentials)
- Visit `http://localhost:3000/analysis/demo`
- Or run:
```bash
curl -X POST http://localhost:3000/api/demo/run
```
This simulates branch creation, migration patching, tests, and PR output.

## Tests
```bash
npm test
```
Included tests:
- OpenAPI diff parsing
- Tree-sitter AST detection
- Patch validation
- Secret redaction
- PR body generation
- Demo flow integration

## GitHub App permissions
- Repository contents: read/write
- Pull requests: read/write
- Checks: read/write
- Metadata: read
- Webhooks: installation, push, pull_request

## Security notes
- Webhook signature verification is enforced at `/api/webhooks/github`
- Demo mode avoids real repository/token usage
- Secret-like values are redacted before LLM-context preparation
- Patches are rejected if they touch unrelated files or lockfiles
- PR output explicitly requires human review and never auto-merges
