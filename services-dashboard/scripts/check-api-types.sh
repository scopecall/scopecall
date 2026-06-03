#!/usr/bin/env bash
# CI gate: verify src/lib/api-types.ts is in sync with schemas/api/v1.yaml.
# Run from services-dashboard/.
# Exits non-zero if the generated types differ from the committed file.
# Mirrors the Go API's `make generate-check` pattern — both sides must stay in sync.
set -euo pipefail

SPEC="../schemas/api/v1.yaml"
CURRENT="src/lib/api-types.ts"
TMP="/tmp/api-types.check.ts"

npx openapi-typescript "$SPEC" -o "$TMP" --silent

if ! diff -q "$CURRENT" "$TMP" > /dev/null 2>&1; then
  echo "ERROR: src/lib/api-types.ts is out of sync with schemas/api/v1.yaml"
  echo ""
  echo "Diff:"
  diff "$CURRENT" "$TMP" || true
  echo ""
  echo "Fix: run the following from services-dashboard/:"
  echo "  npx openapi-typescript ../schemas/api/v1.yaml -o src/lib/api-types.ts"
  exit 1
fi

echo "✓ API types are up to date"
