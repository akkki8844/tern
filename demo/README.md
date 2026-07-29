
# Tern Demo — AcmePay Migration

This demo shows Tern end-to-end:

1. **AcmePay API v1** (`specs/acmepay-v1.yaml`) — legacy `createCharge` / `retrieveCharge` endpoints.
2. **AcmePay API v2** (`specs/acmepay-v2.yaml`) — new `createPayment` / `retrievePayment` endpoints.
3. **Broken TypeScript client** (`broken-app/src/client.ts`) — still uses v1 names and endpoints.
4. **Migration map** (`migration-map.json`) — expected transformation rules.

## Run

```bash
cd demo
bash run-demo.sh
```

## What Tern does

- Loads the v1 and v2 specs and produces a rich diff.
- Scans the broken TypeScript client.
- Matches call sites to breaking changes.
- Applies deterministic rewrites (renaming methods, fields, path params, base URL).
- Validates patches and builds a developer-quality PR.
