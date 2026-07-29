
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
echo "─── Tern AcmePay Demo ───"
echo "1. OpenAPI v1 (legacy): specs/acmepay-v1.yaml"
echo "2. OpenAPI v2 (new):    specs/acmepay-v2.yaml"
echo "3. Broken client:       broken-app/src/client.ts"
echo ""
echo "Diff the specs:"
node --loader ts-node/esm ../packages/openapi/src/diff-demo.ts || true
echo ""
echo "Scan the client:"
node --loader ts-node/esm ../packages/scanner/src/demo-scan.ts broken-app/src || true
echo ""
echo "Generate migration:"
node --loader ts-node/esm ../packages/migration-engine/src/demo-migrate.ts specs/acmepay-v1.yaml specs/acmepay-v2.yaml broken-app/src || true
