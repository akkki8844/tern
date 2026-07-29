
# Tern Demo — AcmePay Migration

This demo runs a complete OpenAPI migration in under two minutes.

## What It Shows

1. **Legacy API** (`specs/acmepay-v1.yaml`): `createCharge` and `retrieveCharge` endpoints.
2. **New API** (`specs/acmepay-v2.yaml`): `createPayment` and `retrievePayment` endpoints.
3. **Broken Client** (`broken-app/src/`): A TypeScript app still using the old endpoints, fields, and operation IDs.
4. **Automated Migration**: Tern diffs the specs, scans the code, generates patches, validates them, and produces a PR-ready report.

## Run the Demo

```bash
cd demo
npm run demo
```

## Expected Output

- Number of API changes detected
- Files scanned, lines parsed, and scan duration
- Call sites found and matched
- Valid patches generated
- Migration engine stats (deterministic rules vs LLM)
- Sandbox test result
- A fully rendered PR body with executive summary, diff summary, affected files, call sites, migration reasoning, and review checklist
