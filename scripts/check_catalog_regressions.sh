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
grep -q "saveCredential('api-key', apiKey)" "$MAIN" \
  || fail "API Key must use the main-process secure credential store"
grep -q "require('node:sqlite')" "$MAIN" \
  || fail "Desktop multi-session storage must use SQLite"
grep -q "conversations:list" "$MAIN" \
  || fail "Desktop must expose fixed conversation capabilities"
grep -q "forceUpgradeBelow" "$MAIN" \
  || fail "Catalog minimum-version policy must be enforced"
if grep -q 'getApiKey' "$PRELOAD"; then
  fail "Preload must not expose API Key access"
fi
grep -q "const IMAGE_MODELS = new Set(\['gpt-image-2'\])" "$MAIN" \
  || fail "Desktop image generation must use the public gpt-image-2 model"
grep -q "'/v1/images/generations'" "$MAIN" \
  || fail "Desktop must use the 15code Images generation endpoint"
grep -q "'/v1/images/edits'" "$MAIN" \
  || fail "Desktop must use the 15code Images editing endpoint"
grep -q '当前账号尚未开通图片权限' "$MAIN" \
  || fail "Desktop image UI must preserve the server permission boundary"
if grep -q 'gpt-image-1.5' "$MAIN" "$HTML"; then
  fail "Desktop must not expose the unpriced gpt-image-1.5 alias"
fi
grep -q "return 'gpt-image-2';" "$HTML" \
  || fail "PPT visuals must use the public gpt-image-2 image model"
grep -q 'window.desktop.generateImage' "$HTML" \
  || fail "PPT visuals must use the desktop 15code image client"
grep -q "clientRequestId: 'ppt-img-' + crypto.randomUUID()" "$HTML" \
  || fail "PPT visuals must use idempotent 15code image request IDs"
if grep -q 'image:pricing\|/api/image-pricing' "$PRELOAD" "$MAIN"; then
  fail "Desktop must not fetch image pricing for display"
fi
if grep -q 'image-pricing\|图片价格\|价格来源：OpenRouter\|单次最大预约' "$HTML"; then
  fail "Desktop must not display image pricing prompts"
fi
grep -q "X-Client-Request-Id" "$MAIN" \
  || fail "Desktop image requests must forward idempotency request IDs"
grep -q "protocol.handle(CHAT_IMAGE_PROTOCOL, serveChatImageAsset)" "$MAIN" \
  || fail "Chat images must be served through the private Electron protocol"
grep -q "hasExpectedImageSignature(asset.mime, bytes)" "$MAIN" \
  || fail "Chat image protocol must reject corrupted or mismatched files"
grep -q "status: 'error'" "$HTML" \
  || fail "Failed chat image operations must retain a recoverable error card"
grep -q "image.status === 'complete'" "$HTML" \
  || fail "Chat image actions must be limited to complete assets"
grep -q "messages.*client_id\|client_id.*messages" "$MAIN" \
  || fail "Chat image persistence must retain stable message client IDs"
if grep -Eqi 'seedream|doubao|ark[.]cn-beijing' "$HTML" "$MAIN"; then
  fail "PPT visuals must not bypass 15code image generation through a separate image provider"
fi

node - "$HTML" <<'NODE'
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const match = html.match(/<script>([\s\S]*)<\/script>/);
if (!match) throw new Error('renderer script block not found');
new Function(match[1]);
NODE

echo "Desktop Catalog regression checks passed"
