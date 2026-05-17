#!/bin/bash
# Interactive Sentry login via Sentry's official CLI.
#
# 1. Install sentry-cli into the state volume (one-time per fresh state).
# 2. Run `sentry-cli login`, which prints an OAuth URL + reads pasted token.
# 3. Parse the resulting ~/.sentryclirc for the auth token.
# 4. List orgs and ask the operator which slug to use.
# 5. Hand off to a tiny bun helper that writes both env keys via the
#    server's setEnvSecret (which also mutates process.env in-process so
#    the health-check tick flips the wizard pill without restart).

set -u
HOME_DIR="${HOME:-/sfb/state/home}"
INSTALL_DIR="$HOME_DIR/.sentry/bin"
SENTRY_CLI="$INSTALL_DIR/sentry-cli"

if [ ! -x "$SENTRY_CLI" ]; then
  echo "▶ Installing sentry-cli into $INSTALL_DIR (one-time)…"
  mkdir -p "$INSTALL_DIR"
  if ! curl -fsSL https://sentry.io/get-cli/ | INSTALL_DIR="$INSTALL_DIR" bash; then
    echo "✗ sentry-cli install failed" >&2
    exit 10
  fi
fi
export PATH="$INSTALL_DIR:$PATH"

if [ ! -x "$SENTRY_CLI" ]; then
  echo "✗ sentry-cli not at $SENTRY_CLI after install" >&2
  exit 11
fi

echo
echo "▶ Running: sentry-cli login"
echo "  Follow the URL it prints, complete OAuth in your browser, and"
echo "  paste the returned token here. The CLI will store it under"
echo "  $HOME_DIR/.sentryclirc."
echo
if ! "$SENTRY_CLI" login; then
  echo "✗ sentry-cli login failed" >&2
  exit 12
fi

if [ ! -f "$HOME_DIR/.sentryclirc" ]; then
  echo "✗ Login completed but no .sentryclirc was written" >&2
  exit 13
fi

TOKEN=$(awk -F= '/^[[:space:]]*token[[:space:]]*=/ { gsub(/[[:space:]"]/, "", $2); print $2; exit }' "$HOME_DIR/.sentryclirc")
if [ -z "$TOKEN" ]; then
  echo "✗ Could not parse token from $HOME_DIR/.sentryclirc" >&2
  exit 14
fi
echo "✓ Got token from .sentryclirc"

echo
echo "▶ Your Sentry organizations:"
"$SENTRY_CLI" organizations list 2>/dev/null || echo "  (couldn't list — paste slug manually)"
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
echo "✓ All set. The Sentry wizard step will flip green on the next health-check tick (≤ 15 min) or click \"Re-run probes\" on /doctor for an instant refresh."
exit 0
