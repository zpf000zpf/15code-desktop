#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HTML="$ROOT/src/index.html"
MAIN="$ROOT/src/main.js"
PRELOAD="$ROOT/src/preload.js"

fail() {
  echo "REGRESSION: $*" >&2
  exit 1
}

grep -q "CATALOG_URL = PLATFORM + '/api/catalog'" "$HTML" \
  || fail "Desktop models must load from the public Catalog"
grep -q 'SUPPORTED_CATALOG_SCHEMA_VERSION = 1' "$HTML" \
  || fail "Desktop must reject unknown Catalog schema versions safely"
grep -q "CATALOG_CACHE_KEY = '15code:catalog:v1'" "$HTML" \
  || fail "Desktop must retain the last successful Catalog"
grep -q 'model.family' "$HTML" \
  || fail "Desktop model grouping must use Catalog family metadata"
grep -q 'm.capabilities.vision' "$HTML" \
  || fail "Desktop must expose Catalog capabilities"

if grep -q "PLATFORM + '/api/pricing'" "$HTML"; then
  fail "Desktop model metadata must not use the authenticated pricing endpoint"
fi
if grep -q "startsWith('claude')" "$HTML"; then
  fail "Desktop model grouping must not guess families from model IDs"
fi
if grep -q 'state.apiKey' "$HTML" || grep -q 'apiKey:' "$HTML"; then
  fail "Renderer must never hold or pass the API Key"
fi
grep -q "safeStorage.encryptString(apiKey)" "$MAIN" \
  || fail "API Key must be encrypted in the main process"
grep -q "require('node:sqlite')" "$MAIN" \
  || fail "Desktop multi-session storage must use SQLite"
grep -q "conversations:list" "$MAIN" \
  || fail "Desktop must expose fixed conversation capabilities"
grep -q "forceUpgradeBelow" "$MAIN" \
  || fail "Catalog minimum-version policy must be enforced"
if grep -q 'getApiKey' "$PRELOAD"; then
  fail "Preload must not expose API Key access"
fi

node - "$HTML" <<'NODE'
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const match = html.match(/<script>([\s\S]*)<\/script>/);
if (!match) throw new Error('renderer script block not found');
new Function(match[1]);
NODE

echo "Desktop Catalog regression checks passed"
