#!/usr/bin/env bash
# Send a HMAC-signed fake Sentry issue_alert webhook to a running server.
# Reads SENTRY_WEBHOOK_SECRET from env or from apps/server/.env.
#
# Usage:
#   SENTRY_WEBHOOK_SECRET=<secret> ./scripts/seed-fake-alert.sh [url]
#   ./scripts/seed-fake-alert.sh  # tries http://localhost:3000/webhooks/sentry

set -euo pipefail

URL="${1:-http://localhost:3000/webhooks/sentry}"

if [ -z "${SENTRY_WEBHOOK_SECRET:-}" ] && [ -f apps/server/.env ]; then
  # shellcheck disable=SC1091
  SENTRY_WEBHOOK_SECRET="$(grep -E '^SENTRY_WEBHOOK_SECRET=' apps/server/.env | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
: "${SENTRY_WEBHOOK_SECRET:?SENTRY_WEBHOOK_SECRET not set}"

BODY=$(cat <<'JSON'
{
  "action": "created",
  "data": {
    "issue": {
      "id": "999000111",
      "title": "TypeError: Cannot read properties of undefined (reading 'foo')",
      "level": "error",
      "project": { "slug": "demo-app" },
      "metadata": { "fingerprint": "fake-fp-001", "type": "TypeError" }
    },
    "event": { "release": "v1.2.3" }
  },
  "installation": { "uuid": "00000000-0000-0000-0000-000000000000" }
}
JSON
)

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SENTRY_WEBHOOK_SECRET" -hex | awk '{print $NF}')

curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "sentry-hook-signature: $SIG" \
  --data-raw "$BODY" \
  -w '\nHTTP %{http_code}\n'
