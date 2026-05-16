#!/usr/bin/env bash
# setup.sh — one-shot bootstrap for sentry-fixer-bot.
#
# Auto-detects environment and switches behavior:
#   * SFB_RUN_MODE=ec2       — installs deps via dnf, starts Postgres in docker,
#                              installs systemd units, configures nginx on :80
#                              (suitable for a fresh Amazon Linux 2023 EC2)
#   * SFB_RUN_MODE=container — assumes deps are pre-installed (from a Dockerfile),
#                              uses an externally provided Postgres via DATABASE_URL,
#                              skips systemd + nginx, runs the server foreground
#                              (suitable for `docker compose up` local testing)
#
# Idempotent. Re-run is safe.

set -euo pipefail

REPO_URL="${SFB_REPO_URL:-https://github.com/shivang2000/sentry-fixer-bot.git}"
REPO_BRANCH="${SFB_REPO_BRANCH:-main}"
APP_DIR="${SFB_APP_DIR:-/opt/sfb/current}"
ENV_FILE="${SFB_ENV_FILE:-/etc/sfb/env}"
WORK_DIR="${SFB_WORK_DIR:-/var/lib/sfb}"
SERVER_PORT="${SFB_SERVER_PORT:-3000}"
HTTP_PORT="${SFB_HTTP_PORT:-80}"

log() { echo -e "\033[36m==>\033[0m $*"; }
err() { echo -e "\033[31m!!\033[0m $*" >&2; }

# ---------------------------------------------------------------------------
# 0. Sanity + helpers
# ---------------------------------------------------------------------------

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    err "sudo not found. Re-run this script as root."
    exit 1
  fi
  SUDO="sudo"
fi

priv() {
  if [[ -n "$SUDO" ]]; then sudo "$@"; else "$@"; fi
}

run_as_sfb() {
  priv runuser -u sfb-runner -- bash -lc "$1"
}

# Mode detection: prefer explicit override, fall back to auto.
SFB_RUN_MODE="${SFB_RUN_MODE:-auto}"
if [[ "$SFB_RUN_MODE" == "auto" ]]; then
  if [[ -f /.dockerenv ]] || grep -qE 'docker|containerd|podman|kubepods' /proc/1/cgroup 2>/dev/null; then
    SFB_RUN_MODE=container
  else
    SFB_RUN_MODE=ec2
  fi
fi
log "run mode: $SFB_RUN_MODE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CHECKOUT=""
if [[ -f "$SCRIPT_DIR/package.json" ]] && [[ -d "$SCRIPT_DIR/apps/server" ]]; then
  LOCAL_CHECKOUT="$SCRIPT_DIR"
fi

# ---------------------------------------------------------------------------
# 1. System dependencies (EC2 only — container has them from the Dockerfile)
# ---------------------------------------------------------------------------
if [[ "$SFB_RUN_MODE" == "ec2" ]]; then
  log "step 1/8: installing system dependencies (this can take 3-5 min)"
  if [[ -n "$LOCAL_CHECKOUT" ]] && [[ -x "$LOCAL_CHECKOUT/deploy/ec2/bootstrap-al2023.sh" ]]; then
    priv bash "$LOCAL_CHECKOUT/deploy/ec2/bootstrap-al2023.sh"
  else
    TMP_BOOT="$(mktemp)"
    curl -fsSL \
      "https://raw.githubusercontent.com/shivang2000/sentry-fixer-bot/${REPO_BRANCH}/deploy/ec2/bootstrap-al2023.sh" \
      -o "$TMP_BOOT"
    priv bash "$TMP_BOOT"
    rm -f "$TMP_BOOT"
  fi
else
  log "step 1/8: skipping system-deps install (container mode — Dockerfile already did it)"
fi

# Refresh PATH so bun/node/claude are picked up.
for d in /usr/local/bin /usr/local/sbin; do
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH

for cmd in bun node git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "required tool '$cmd' is not on PATH. Aborting."
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 2. Ensure the repo is at $APP_DIR
# ---------------------------------------------------------------------------
log "step 2/8: ensuring repo is at $APP_DIR"
priv install -d -m 0755 "$(dirname "$APP_DIR")"
priv git config --system --add safe.directory "$APP_DIR" 2>/dev/null || true

if [[ "$SFB_RUN_MODE" == "container" ]]; then
  # The repo is bind-mounted (dev compose) or baked into the image
  # (prod compose). Container has no SSH config + no GitHub creds, so
  # never attempt a git fetch. Just confirm the source is present.
  if [[ ! -d "$APP_DIR" ]]; then
    err "container mode expects the repo at $APP_DIR (bind-mount or COPY) — not found"
    exit 1
  fi
  log "  repo present (container mode, source is from host or image)"
elif [[ -n "$LOCAL_CHECKOUT" ]] && [[ "$LOCAL_CHECKOUT" != "$APP_DIR" ]]; then
  priv rm -rf "$APP_DIR"
  priv cp -a "$LOCAL_CHECKOUT" "$APP_DIR"
elif [[ -d "$APP_DIR/.git" ]]; then
  log "  repo already present; fetching latest"
  if id -u sfb-runner >/dev/null 2>&1 && [[ "$(stat -c '%U' "$APP_DIR")" == "sfb-runner" ]]; then
    run_as_sfb "cd '$APP_DIR' && git fetch --quiet origin && git reset --quiet --hard 'origin/${REPO_BRANCH}'"
  else
    priv git -C "$APP_DIR" fetch --quiet origin
    priv git -C "$APP_DIR" reset --quiet --hard "origin/${REPO_BRANCH}"
  fi
elif [[ -z "$LOCAL_CHECKOUT" ]]; then
  priv git clone --branch "$REPO_BRANCH" --depth 50 "$REPO_URL" "$APP_DIR"
fi

# Make sure sfb-runner can read the repo (EC2 mode).
if [[ "$SFB_RUN_MODE" == "ec2" ]]; then
  priv chown -R sfb-runner:sfb-runner "$APP_DIR" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 3. Generate (or refresh) /etc/sfb/env
# ---------------------------------------------------------------------------
log "step 3/8: generating $ENV_FILE"

# In container mode the orchestrator (docker-compose) supplies DATABASE_URL,
# BETTER_AUTH_URL, etc. via the env; honour those.
if [[ "$SFB_RUN_MODE" == "container" ]]; then
  : "${DATABASE_URL:?DATABASE_URL must be set in container mode}"
  PUBLIC_URL="${PUBLIC_BASE_URL:-${BETTER_AUTH_URL:-http://localhost:${SERVER_PORT}}}"
  DB_URL="$DATABASE_URL"
  DEPLOY_MODE_DEFAULT="${DEPLOYMENT_MODE:-authenticated}"
  BIND_DEFAULT="${SERVER_BIND:-custom}"
  BIND_HOST_DEFAULT="${SERVER_BIND_HOST:-0.0.0.0}"
else
  # EC2 mode: detect the public IPv4 via instance metadata; fall back to ipify.
  PUBLIC_IP=""
  if curl -fsSL --max-time 3 -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
     -X PUT http://169.254.169.254/latest/api/token >/tmp/_imds-token 2>/dev/null; then
    IMDS_TOKEN="$(cat /tmp/_imds-token)"
    PUBLIC_IP="$(curl -fsSL --max-time 3 \
      -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
      http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
    rm -f /tmp/_imds-token
  fi
  if [[ -z "$PUBLIC_IP" ]]; then
    PUBLIC_IP="$(curl -fsSL --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  fi
  [[ -z "$PUBLIC_IP" ]] && PUBLIC_IP="localhost"
  PUBLIC_URL="http://${PUBLIC_IP}"
  DB_URL="postgres://postgres:password@127.0.0.1:5433/sentry-fixer-bot"
  DEPLOY_MODE_DEFAULT="authenticated"
  BIND_DEFAULT="custom"
  BIND_HOST_DEFAULT="127.0.0.1"
fi

# Preserve an existing BETTER_AUTH_SECRET (don't invalidate sessions on re-run).
EXISTING_SECRET=""
if [[ -f "$ENV_FILE" ]]; then
  EXISTING_SECRET="$(priv grep -E '^BETTER_AUTH_SECRET=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
fi
if [[ -z "$EXISTING_SECRET" ]]; then
  EXISTING_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -base64 48 | tr -d '\n=')}"
fi

if [[ "$SFB_RUN_MODE" == "container" ]]; then
  # Container mode: settings UI (running as sfb-runner) needs to atomically
  # rewrite $ENV_FILE — that means it must create tmp files in this dir, so
  # the group needs write access. EC2 mode keeps the stricter 0750 because
  # systemd reads the file and there is no UI-driven secret editor on the
  # filesystem the bot can self-modify.
  priv install -d -m 0770 -o root -g sfb-runner "$(dirname "$ENV_FILE")" 2>/dev/null || \
    priv install -d -m 0775 "$(dirname "$ENV_FILE")"
else
  priv install -d -m 0750 -o root -g sfb-runner "$(dirname "$ENV_FILE")" 2>/dev/null || \
    priv install -d -m 0755 "$(dirname "$ENV_FILE")"
fi

# In container mode the env file lives on a named docker volume
# (sfb_dev_etc_sfb) so it survives container restarts AND captures every
# secret the operator paste into the /settings UI between boots. If a
# prior boot already populated it, leave it alone — otherwise we would
# clobber every UI-set ANTHROPIC_API_KEY / GITHUB_APP_ID / etc. on every
# `docker compose up`. To intentionally reset, `docker compose down -v`.
if [[ "$SFB_RUN_MODE" == "container" ]] && [[ -s "$ENV_FILE" ]] && \
   priv grep -q '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null; then
  log "  env file already populated; preserving (down -v to reset)"
else

priv tee "${ENV_FILE}.tmp" >/dev/null <<EOF
# Generated by setup.sh on $(date -u +%FT%TZ)
# Mode: ${SFB_RUN_MODE}

# --- Required to boot ---
DATABASE_URL=${DB_URL}
BETTER_AUTH_SECRET=${EXISTING_SECRET}
BETTER_AUTH_URL=${PUBLIC_URL}
CORS_ORIGIN=${PUBLIC_URL}
NODE_ENV=${NODE_ENV:-production}
PUBLIC_BASE_URL=${PUBLIC_URL}

# --- Deployment topology ---
DEPLOYMENT_MODE=${DEPLOY_MODE_DEFAULT}
SERVER_BIND=${BIND_DEFAULT}
SERVER_BIND_HOST=${BIND_HOST_DEFAULT}

# --- Web build-time (Vite inlines VITE_* into the JS bundle) ---
VITE_SERVER_URL=${VITE_SERVER_URL:-${PUBLIC_URL}}

# --- Agent runtime ---
WORK_DIR=${WORK_DIR}/work
CLAUDE_BIN=/usr/local/bin/claude
CLAUDE_MODEL=claude-opus-4-7
AGENT_TIMEOUT_SECONDS=900

# --- Configure via UI or operator ---
# ANTHROPIC_API_KEY=
# SENTRY_WEBHOOK_SECRET=
# SENTRY_API_TOKEN=
# SENTRY_ORG_SLUG=
# GITHUB_APP_ID=
# GITHUB_APP_INSTALLATION_ID=
# GITHUB_APP_PRIVATE_KEY_PATH=
# S3_BUCKET=
# S3_REGION=
EOF
if [[ "$SFB_RUN_MODE" == "container" ]]; then
  # Container mode: secret-writer (running as sfb-runner) must overwrite this
  # file from /settings. 0660 + root:sfb-runner gives it group write.
  priv chmod 0660 "${ENV_FILE}.tmp"
else
  priv chmod 0640 "${ENV_FILE}.tmp"
fi
priv chown root:sfb-runner "${ENV_FILE}.tmp" 2>/dev/null || true
priv mv "${ENV_FILE}.tmp" "$ENV_FILE"
fi  # end: container env-file preservation guard

# ---------------------------------------------------------------------------
# 4. Postgres
# ---------------------------------------------------------------------------
if [[ "$SFB_RUN_MODE" == "ec2" ]]; then
  log "step 4/8: starting Postgres in docker"
  COMPOSE_FILE="$APP_DIR/packages/db/docker-compose.yml"
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    err "docker-compose.yml not found at $COMPOSE_FILE"
    exit 1
  fi
  priv docker compose -f "$COMPOSE_FILE" up -d

  log "  waiting for Postgres healthcheck"
  for i in $(seq 1 60); do
    if priv docker inspect --format='{{.State.Health.Status}}' sentry-fixer-bot-postgres 2>/dev/null | grep -q healthy; then
      log "  Postgres ready"
      break
    fi
    sleep 2
    if [[ "$i" -eq 60 ]]; then
      err "Postgres did not become healthy in 120s"
      priv docker logs --tail 30 sentry-fixer-bot-postgres || true
      exit 1
    fi
  done
else
  log "step 4/8: waiting for external Postgres at $DATABASE_URL"
  for i in $(seq 1 60); do
    if run_as_sfb "cd '$APP_DIR' && bun run -e 'await Bun.sql\`select 1\`.simple()' 2>/dev/null" >/dev/null 2>&1; then
      log "  Postgres reachable"
      break
    fi
    sleep 2
    if [[ "$i" -eq 60 ]]; then
      err "could not reach Postgres at $DATABASE_URL after 120s"
      exit 1
    fi
  done
fi

# ---------------------------------------------------------------------------
# 5. Install workspace deps + migrate + build
# ---------------------------------------------------------------------------
log "step 5/8: installing workspace dependencies (bun install)"
run_as_sfb "cd '$APP_DIR' && bun install --frozen-lockfile"

log "  applying database migrations"
run_as_sfb \
  "cd '$APP_DIR' && set -a && . '$ENV_FILE' && set +a && bun --filter=@sentry-fixer-bot/db db:migrate"

log "  building web bundle (apps/web → apps/server/public)"
run_as_sfb \
  "cd '$APP_DIR' && set -a && . '$ENV_FILE' && set +a && bun run build"

# ---------------------------------------------------------------------------
# 6. systemd (EC2 only)
# ---------------------------------------------------------------------------
if [[ "$SFB_RUN_MODE" == "ec2" ]]; then
  log "step 6/8: installing systemd units"
  for unit in sfb-server.service sfb-worker.service sfb-backup.service sfb-backup.timer; do
    src="$APP_DIR/deploy/systemd/$unit"
    if [[ -f "$src" ]]; then
      priv install -m 0644 "$src" "/etc/systemd/system/$unit"
    fi
  done
  priv systemctl daemon-reload
  priv systemctl enable sfb-server.service sfb-worker.service
  priv systemctl restart sfb-server.service sfb-worker.service
  if [[ -f /etc/systemd/system/sfb-backup.timer ]]; then
    priv systemctl enable --now sfb-backup.timer || true
  fi
else
  log "step 6/8: skipping systemd (container mode)"
fi

# ---------------------------------------------------------------------------
# 7. nginx reverse proxy (EC2 only)
# ---------------------------------------------------------------------------
if [[ "$SFB_RUN_MODE" == "ec2" ]]; then
  log "step 7/8: configuring nginx ($HTTP_PORT → $SERVER_PORT)"
  priv tee /etc/nginx/conf.d/sfb.conf >/dev/null <<NGINX
upstream sfb_server {
  server 127.0.0.1:${SERVER_PORT};
  keepalive 16;
}

server {
  listen ${HTTP_PORT} default_server;
  server_name _;

  client_max_body_size 8m;

  location /api/chat/ {
    proxy_pass         http://sfb_server;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           \$http_upgrade;
    proxy_set_header   Connection        "upgrade";
    proxy_set_header   Host              \$host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location / {
    proxy_pass         http://sfb_server;
    proxy_http_version 1.1;
    proxy_set_header   Host              \$host;
    proxy_set_header   X-Real-IP         \$remote_addr;
    proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }
}
NGINX
  if [[ -f /etc/nginx/nginx.conf ]] && grep -q 'listen.*80.*default_server' /etc/nginx/nginx.conf; then
    priv sed -i 's/listen[[:space:]]\+80[[:space:]]\+default_server/listen 8080/g' /etc/nginx/nginx.conf || true
  fi
  priv nginx -t
  priv systemctl reload nginx 2>/dev/null || priv systemctl restart nginx || priv nginx -s reload || priv nginx
else
  log "step 7/8: skipping nginx (container mode; map host port directly to ${SERVER_PORT})"
fi

# ---------------------------------------------------------------------------
# 8. Run the server
# ---------------------------------------------------------------------------
if [[ "$SFB_RUN_MODE" == "ec2" ]]; then
  log "step 8/8: smoke checks"
  sleep 3
  for i in $(seq 1 20); do
    if curl -fsSL "http://127.0.0.1:${SERVER_PORT}/healthz" >/dev/null 2>&1; then
      log "  /healthz OK"
      break
    fi
    sleep 1
    if [[ "$i" -eq 20 ]]; then
      err "/healthz did not respond. Check: sudo journalctl -fu sfb-server"
    fi
  done

  cat <<DONE

\033[32m✓ Setup complete.\033[0m

  Public URL : ${PUBLIC_URL}
  Health     : ${PUBLIC_URL}/healthz
  Sign up    : ${PUBLIC_URL}/sign-up   (first user becomes admin)

EC2 reminders:
  * Make sure the security group allows inbound TCP ${HTTP_PORT}
  * For TLS / a domain, point DNS at this instance, then run:
        sudo dnf -y install certbot python3-certbot-nginx
        sudo certbot --nginx -d your.domain.com

Service logs : sudo journalctl -fu sfb-server | sudo journalctl -fu sfb-worker
Operator runbook : ${APP_DIR}/docs/runbook.md

DONE
else
  log "step 8/8: launching sfb-server in foreground (container mode)"
  cat <<DONE

\033[32m✓ Container ready. Starting sfb-server now…\033[0m

  Visit  : ${PUBLIC_URL}
  Health : ${PUBLIC_URL}/healthz
  Signup : ${PUBLIC_URL}/sign-up   (first user becomes admin)

DONE
  # Hand the container PID 1 over to the server process so logs stream to
  # `docker compose logs -f` and a SIGTERM kills the app cleanly.
  cd "$APP_DIR"
  exec runuser -u sfb-runner -- bash -lc \
    "cd '$APP_DIR' && set -a && . '$ENV_FILE' && set +a && exec bun apps/server/src/index.ts"
fi
