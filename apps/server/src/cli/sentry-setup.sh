#!/bin/bash
# Interactive Sentry login. Spawned by /api/login/sentry through the
# onboarding wizard.
#
# 1. Locate sentry-cli. It's baked into the image at build time
#    (deploy/ec2/bootstrap-al2023.sh). A stale image without it falls back to
#    the official get-cli installer — which pulls from Sentry's own CDN, NOT
#    the GitHub API, so it can't hit the unauthenticated rate-limit 403 the
#    cli.sentry.dev installer does.
# 2. Surface the auth-tokens URL, read the pasted token from stdin.
# 3. Validate the token with `sentry-cli organizations list` — its exit code
#    is honest (1 on bad auth), unlike `sentry-cli login` which returns 0 even
#    on a 401. Store it so other sentry-cli calls in the app reuse it.
# 4. Ask which org slug to use, then hand off to a bun shim that writes both
#    env keys via setEnvSecret (mutates process.env in-process so the
#    health-check tick flips the wizard pill without a restart).

set -u
HOME_DIR="${HOME:-/alertforge/state/home}"

# Prefer the binary baked into the image; fall back to the state volume.
SENTRY_BIN="$(command -v sentry-cli || true)"
if [ -z "$SENTRY_BIN" ]; then
  SENTRY_BIN="$HOME_DIR/.sentry/bin/sentry-cli"
fi

if [ ! -x "$SENTRY_BIN" ]; then
  echo "▶ sentry-cli not on PATH — installing into $HOME_DIR/.sentry/bin (one-time)…"
  if ! curl -sL https://sentry.io/get-cli/ | INSTALL_DIR="$HOME_DIR/.sentry/bin" sh; then
    echo "✗ sentry-cli install failed" >&2
    exit 10
  fi
  SENTRY_BIN="$HOME_DIR/.sentry/bin/sentry-cli"
fi

if [ ! -x "$SENTRY_BIN" ]; then
  echo "✗ sentry-cli not found at $SENTRY_BIN" >&2
  exit 11
fi

echo
echo "┌─ Sentry login ─────────────────────────────────────────────┐"
echo "│ Open the following URL, create an auth token (org-level     │"
echo "│ 'Read' scope is enough), and paste it back here.            │"
echo "└─────────────────────────────────────────────────────────────┘"
echo
# "Open the following URL" is one of the OAuth-URL detector's hint phrases
# (apps/server/src/chat/url-detector.ts), so the wizard surfaces this link on
# the OAuthCard for a one-click open.
echo "Open the following URL:"
echo "  https://sentry.io/settings/account/api/auth-tokens/"
echo

# The operator types/pastes the token straight into the xterm; keystrokes are
# forwarded to this process's stdin by the login WS.
read -r -p "Paste your Sentry auth token: " TOKEN
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
if [ -z "$TOKEN" ]; then
  echo "✗ Empty token. Aborting." >&2
  exit 2
fi

# Store globally so the rest of the app's sentry-cli usage reuses it. Note:
# `login --auth-token` exits 0 even when the token is rejected (401), so its
# exit code is NOT trusted — the `info` check below is the gate.
"$SENTRY_BIN" login --auth-token "$TOKEN" >/dev/null 2>&1 || true

echo
echo "▶ Validating token against sentry.io…"
# `sentry-cli info` is the honest gate: exit 0 when the token authenticates,
# 1 otherwise. We deliberately do NOT use `organizations list` — sentry-cli
# 3.4.x can't parse current sentry.io org JSON (fails with "missing field
# requireEmailVerification") and rejects even valid tokens.
if ! "$SENTRY_BIN" info --auth-token "$TOKEN" --no-defaults >/dev/null 2>&1; then
  echo "✗ Sentry rejected the token. Re-check it at" >&2
  echo "  https://sentry.io/settings/account/api/auth-tokens/" >&2
  exit 4
fi
echo "✓ Token accepted by Sentry."

echo
echo "▶ Your Sentry organizations:"
# sentry-cli's org list is broken (see above), so read slugs straight from the
# REST API. The token already validated, so this returns the org array.
ORG_SLUGS="$(curl -sS -H "Authorization: Bearer $TOKEN" "https://sentry.io/api/0/organizations/" \
  | grep -oE '"slug":"[^"]*"' | sed -E 's/"slug":"([^"]*)"/  \1/')"
if [ -n "$ORG_SLUGS" ]; then
  echo "$ORG_SLUGS"
else
  echo "  (none returned — paste your slug manually)"
fi
echo
read -r -p "Org slug to use (e.g. acme-corp): " ORG
ORG="$(printf '%s' "$ORG" | tr -d '[:space:]')"
if [ -z "$ORG" ]; then
  echo "✗ Empty org slug, aborting" >&2
  exit 15
fi

echo
echo "▶ Writing SENTRY_API_TOKEN + SENTRY_ORG_SLUG to /alertforge/state/etc/env…"
# Resolve the helper next to this script so a repo rename / relocation can't
# strand the path (it used to be hardcoded to /opt/sfb/current).
if ! bun run "$(dirname "$0")/write-sentry-secret.ts" "$TOKEN" "$ORG"; then
  echo "✗ env-file write failed" >&2
  exit 16
fi

echo
echo "✓ All set. Wizard step flips green on the next health-check tick or click \"Re-run probes\" on /doctor."
exit 0
