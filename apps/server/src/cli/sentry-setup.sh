#!/bin/bash
# Interactive Sentry login via the official `sentry` CLI from cli.sentry.dev.
#
# 1. Install sentry binary into the state volume (one-time per fresh state).
# 2. Run `sentry auth login` — Sentry's device-code OAuth.
# 3. Parse the resulting config file for the auth token.
# 4. Ask the operator which org slug to use.
# 5. Hand off to a tiny bun helper that writes both env keys via the
#    server's setEnvSecret (mutates process.env in-process so the
#    health-check tick flips the wizard pill without restart).

set -u
HOME_DIR="${HOME:-/sfb/state/home}"
INSTALL_DIR="$HOME_DIR/.sentry/bin"
SENTRY_BIN="$INSTALL_DIR/sentry"

if [ ! -x "$SENTRY_BIN" ]; then
  echo "▶ Installing sentry CLI into $INSTALL_DIR (one-time)…"
  mkdir -p "$INSTALL_DIR"
  # cli.sentry.dev installer respects $SENTRY_HOME for the destination.
  export SENTRY_HOME="$HOME_DIR/.sentry"
  if ! curl -fsSL https://cli.sentry.dev/install | bash; then
    echo "✗ sentry CLI install failed" >&2
    exit 10
  fi
fi
export PATH="$INSTALL_DIR:$PATH"

if [ ! -x "$SENTRY_BIN" ]; then
  echo "✗ sentry CLI not found at $SENTRY_BIN after install" >&2
  exit 11
fi

echo
echo "▶ Running: sentry auth login"
echo "  Open the URL it prints in your browser, complete OAuth, and the"
echo "  CLI will store the token under $HOME_DIR/.sentry/."
echo
if ! "$SENTRY_BIN" auth login; then
  echo "✗ sentry auth login failed" >&2
  exit 12
fi

# The new sentry CLI stores creds in $SENTRY_HOME/credentials (JSON) or
# at the legacy $HOME/.sentryclirc path. Probe both.
TOKEN=""
if [ -f "$HOME_DIR/.sentry/credentials" ]; then
  TOKEN=$("$SENTRY_BIN" config get auth.token 2>/dev/null | tail -1 | tr -d '[:space:]"')
fi
if [ -z "$TOKEN" ] && [ -f "$HOME_DIR/.sentryclirc" ]; then
  TOKEN=$(awk -F= '/^[[:space:]]*token[[:space:]]*=/ { gsub(/[[:space:]"]/, "", $2); print $2; exit }' "$HOME_DIR/.sentryclirc")
fi
if [ -z "$TOKEN" ]; then
  echo "✗ Could not read token after login. Try: $SENTRY_BIN config get auth.token" >&2
  exit 14
fi
echo "✓ Got token from sentry CLI config"

echo
echo "▶ Your Sentry organizations:"
"$SENTRY_BIN" organizations list 2>/dev/null || echo "  (couldn't list — paste slug manually)"
echo
read -r -p "Org slug to use (e.g. acme-corp): " ORG
if [ -z "$ORG" ]; then
  echo "✗ Empty org slug, aborting" >&2
  exit 15
fi

echo
echo "▶ Writing SENTRY_API_TOKEN + SENTRY_ORG_SLUG to /sfb/state/etc/env…"
if ! bun run /opt/sfb/current/apps/server/src/cli/write-sentry-secret.ts "$TOKEN" "$ORG"; then
  echo "✗ env-file write failed" >&2
  exit 16
fi

echo
echo "✓ All set. Wizard step flips green on next health-check tick (≤ 15 min) or click \"Re-run probes\" on /doctor."
exit 0
