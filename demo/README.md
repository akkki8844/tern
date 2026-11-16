# Capibara demo — AcmePay

A complete, offline run of the Capibara pipeline.

## What is here

| Path | Contents |
| --- | --- |
| `specs/acmepay-v1.yaml` | The old API: `createCharge`, `retrieveCharge` |
| `specs/acmepay-v2.yaml` | The new API: `createPayment`, `retrievePayment`, renamed fields, changed path parameters |
| `broken-app/` | A small TypeScript client still written against v1 |
| `migration-map.json` | The renames a human would apply, used as the demo AI's rename table |

## Run it

From the repository root:

```bash
npm run build:packages
npm run demo
```

No database, no GitHub App, no AI key and no network access are required.

## What actually runs

The diffing, scanning, deterministic migration, patch validation and sandboxed
`npm install` / `npm test` are all the real implementations. Only GitHub, the AI
provider and the repository checkout are in-memory. See
[`../docs/demo-mode.md`](../docs/demo-mode.md).

## What to expect

Roughly:

* 6 breaking changes and 2 risky changes detected between v1 and v2
* ~19 affected call sites across 6 files (tree-sitter)
* 3 patches generated and validated
* the sandbox runs `npm install` and `npm test` against the patched checkout
* `PUBLISH` is **skipped**, with the reason `verification failed at the "test" step`

That last point is intentional. The demo client is deliberately broken in ways the
current rule set does not fully repair, so the sandbox fails — and Capibara refuses to open
a pull request rather than claiming a migration that was never proven.
