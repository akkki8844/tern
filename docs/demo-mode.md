# Demo mode

Demo mode runs the **real** pipeline with in-memory providers. It exists so the system
can be demonstrated and smoke-tested without a GitHub App, an AI key, or any network
access at all.

```bash
npm run build:packages
npm run demo
```

Entry point: `apps/worker/src/demo.ts`. It is a separate entrypoint from the production
worker so demo wiring can never leak into a real deployment.

## What is real and what is not

| Component | Demo mode |
| --- | --- |
| OpenAPI diffing | **Real** — `packages/openapi` |
| Repository scanning | **Real** — tree-sitter over `demo/broken-app` |
| Deterministic migration | **Real** — `packages/migration-engine` |
| Patch validation | **Real** — the same validator production uses |
| Sandbox verification | **Real** — `npm install` and `npm test` actually run |
| GitHub | In memory (`DemoGitHubProvider`, URLs on `github.invalid`) |
| AI fallback | In memory (`DemoAIProvider`, a fixed rename table) |
| Repository checkout | Local copy (`LocalRepositoryProvider`) |
| Database | Not used by the demo entrypoint |

`DemoGitHubProvider.isReal` is `false`, and the pipeline only enables the `PUBLISH`
stage for a provider that reports `isReal`. Demo mode therefore cannot create a branch,
a commit or a pull request anywhere real.

## Expected outcome

The bundled AcmePay example is deliberately broken against the v2 specification. A demo
run currently reports something like:

```
DISCOVER:SUCCEEDED DIFF:SUCCEEDED SCAN:SUCCEEDED PLAN:SUCCEEDED
MIGRATE:SUCCEEDED VALIDATE:SUCCEEDED TEST:SUCCEEDED PUBLISH:SUCCEEDED
```

with 6 breaking changes detected, ~19 affected call sites, 3 validated patches, and
`PUBLISH` skipped with `verification failed at the "test" step`.

That last line is the point: the demo application's tests still fail after the patches
are applied, so Capibara refuses to publish. Capibara never reports a migration as successful
unless the sandbox actually proved it.

## Enabling demo mode for the whole service

Set `CAPIBARA_MODE=demo`. The worker and the web app will both select demo providers, and
the configuration validator relaxes the production requirement for GitHub App
credentials. Demo mode is reported in the health endpoint response.
