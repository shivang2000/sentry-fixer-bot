#!/usr/bin/env bash
# bootstrap-al2023.sh
#
# Idempotent bootstrap for a fresh Amazon Linux 2023 EC2 instance.
# Installs: git, gh, docker (+ compose plugin), nvm + Node LTS + npm,
# bun, claude CLI, postgres-client, nginx, AWS CLI v2, jq, unzip.
#
# Tested on: t3a.small (AL2023, x86_64). Should also work on t4g.* (arm64).
#
# Usage on a fresh instance:
#   scp -i <key>.pem bootstrap-al2023.sh ec2-user@<ip>:/tmp/
#   ssh -i <key>.pem ec2-user@<ip>
#   sudo bash /tmp/bootstrap-al2023.sh
#
# Or one-liner over SSH:
#   ssh -i <key>.pem ec2-user@<ip> 'sudo bash -s' < bootstrap-al2023.sh

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: must run as root (use sudo)" >&2
  exit 1
fi

# Detect container environments (docker, podman, CI) so we can skip the
# systemd-dependent steps that would fail without PID 1 = systemd.
in_container() {
  [[ -f /.dockerenv ]] || grep -qE 'docker|containerd|podman|kubepods' /proc/1/cgroup 2>/dev/null
}
IN_CONTAINER=0
if in_container; then
  IN_CONTAINER=1
  echo "==> container environment detected — systemctl + service enables will be skipped"
fi

# Stub systemctl when inside a container without systemd so the rest of the
# script can run unchanged.
if [[ "$IN_CONTAINER" -eq 1 ]] && ! pidof systemd >/dev/null 2>&1; then
  systemctl() { echo "(skip) systemctl $*"; return 0; }
fi

ARCH="$(uname -m)"  # x86_64 or aarch64

log() { echo "==> $*"; }

# dnf install wrapper. In container builds (BuildKit) the post-install
# scriptlets that touch systemd return non-zero even when every package
# installs cleanly, which surfaces as exit code 2 from dnf and aborts
# the build. Skip scriptlets in container mode; on a real EC2 they
# matter and run normally.
dnf_install() {
  if [[ "$IN_CONTAINER" -eq 1 ]]; then
    dnf -y -q install --setopt=tsflags=noscripts "$@"
  else
    dnf -y -q install "$@"
  fi
}

# ---------- system packages ----------
# Note: AL2023 ships curl-minimal + ca-certificates preinstalled; the full
# curl package conflicts with curl-minimal, so we omit both.
# shadow-utils MUST land before the useradd block below — minimal AL2023
# images (including docker amazonlinux:2023) ship without it.
log "dnf base packages"
dnf -y -q update --allowerasing
dnf_install --allowerasing \
  git tar gzip unzip jq which procps-ng \
  nginx \
  postgresql15 \
  shadow-utils

# Pre-create ec2-user when running in a fresh container (real EC2 has it
# from cloud-init). Must run AFTER shadow-utils install.
if [[ "$IN_CONTAINER" -eq 1 ]] && ! id ec2-user >/dev/null 2>&1; then
  log "creating ec2-user (container env)"
  groupadd -f wheel
  useradd --create-home --shell /bin/bash --groups wheel ec2-user
fi

# Resolve the non-root login user (cloud-init default on AL2023 is ec2-user).
LOGIN_USER="${SUDO_USER:-ec2-user}"
LOGIN_HOME="$(getent passwd "$LOGIN_USER" | cut -d: -f6)"
if [[ -z "$LOGIN_HOME" ]]; then
  echo "error: cannot resolve home for user $LOGIN_USER" >&2
  exit 1
fi

# ---------- Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  log "installing docker"
  dnf_install docker
fi
systemctl enable --now docker
usermod -aG docker "$LOGIN_USER" || true

# docker compose plugin (AL2023 ships docker but compose-plugin needs the
# upstream GitHub release dropped into the plugins dir)
COMPOSE_VERSION="v2.31.0"
COMPOSE_BIN="/usr/libexec/docker/cli-plugins/docker-compose"
if [[ ! -x "$COMPOSE_BIN" ]]; then
  log "installing docker compose plugin ($COMPOSE_VERSION)"
  case "$ARCH" in
    x86_64) COMPOSE_ARCH="x86_64" ;;
    aarch64) COMPOSE_ARCH="aarch64" ;;
    *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
  esac
  install -d -m 0755 "$(dirname "$COMPOSE_BIN")"
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" \
    -o "$COMPOSE_BIN"
  chmod 0755 "$COMPOSE_BIN"
fi

# ---------- GitHub CLI ----------
if ! command -v gh >/dev/null 2>&1; then
  log "installing gh"
  # The official repo is RPM-based and works on AL2023.
  dnf_install 'dnf-command(config-manager)'
  dnf -y -q config-manager addrepo \
    --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo \
    || dnf -y -q config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
  dnf_install gh --repo gh-cli
fi

# ---------- nvm + Node LTS + npm ----------
NVM_DIR="$LOGIN_HOME/.nvm"
if [[ ! -d "$NVM_DIR" ]]; then
  log "installing nvm into $NVM_DIR"
  runuser -u "$LOGIN_USER" -- bash -c \
    "export PROFILE=/dev/null; curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
fi

# Make nvm + node available to all login shells.
PROFILE_SNIPPET="/etc/profile.d/nvm.sh"
cat >"$PROFILE_SNIPPET" <<EOF
export NVM_DIR="$NVM_DIR"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
EOF
chmod 0644 "$PROFILE_SNIPPET"

log "installing Node LTS via nvm"
runuser -u "$LOGIN_USER" -- bash -lc '
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm alias default lts/*
  node -v
  npm -v
'

# Symlink node + npm into /usr/local/bin so systemd units + non-login shells
# can find them without sourcing nvm.
NODE_BIN="$(runuser -u "$LOGIN_USER" -- bash -lc 'command -v node')"
NPM_BIN="$(runuser -u "$LOGIN_USER" -- bash -lc 'command -v npm')"
ln -sf "$NODE_BIN" /usr/local/bin/node
ln -sf "$NPM_BIN" /usr/local/bin/npm

# ---------- Bun ----------
if ! command -v bun >/dev/null 2>&1; then
  log "installing bun for $LOGIN_USER"
  runuser -u "$LOGIN_USER" -- bash -c 'curl -fsSL https://bun.sh/install | bash'
  install -m 0755 "$LOGIN_HOME/.bun/bin/bun" /usr/local/bin/bun
fi

# ---------- Claude Code CLI ----------
if ! command -v claude >/dev/null 2>&1; then
  log "installing claude code CLI for $LOGIN_USER"
  # claude installer is npm-based; nvm-installed npm is on $PATH for login shells.
  runuser -u "$LOGIN_USER" -- bash -lc '
    export NVM_DIR="$HOME/.nvm"
    . "$NVM_DIR/nvm.sh"
    npm install -g @anthropic-ai/claude-code
  '
  CLAUDE_BIN="$(runuser -u "$LOGIN_USER" -- bash -lc 'command -v claude' || true)"
  if [[ -n "$CLAUDE_BIN" ]]; then
    ln -sf "$CLAUDE_BIN" /usr/local/bin/claude
  fi
fi

# ---------- AWS CLI v2 ----------
if ! command -v aws >/dev/null 2>&1; then
  log "installing AWS CLI v2"
  case "$ARCH" in
    x86_64) AWS_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" ;;
    aarch64) AWS_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" ;;
  esac
  TMP="$(mktemp -d)"
  curl -fsSL "$AWS_URL" -o "$TMP/awscli.zip"
  unzip -q "$TMP/awscli.zip" -d "$TMP"
  "$TMP/aws/install" --update
  rm -rf "$TMP"
fi

# ---------- nginx ----------
systemctl enable --now nginx

# ---------- App scaffolding ----------
SFB_RUNNER="sfb-runner"
if ! id "$SFB_RUNNER" >/dev/null 2>&1; then
  log "creating system user $SFB_RUNNER (uid 4000)"
  useradd --system --uid 4000 --create-home --shell /bin/bash "$SFB_RUNNER"
fi
install -d -m 0755 -o "$SFB_RUNNER" -g "$SFB_RUNNER" /opt/sfb
install -d -m 0755 -o "$SFB_RUNNER" -g "$SFB_RUNNER" /var/lib/sfb
install -d -m 0755 -o "$SFB_RUNNER" -g "$SFB_RUNNER" /var/lib/sfb/work
install -d -m 0755 -o "$SFB_RUNNER" -g "$SFB_RUNNER" /var/lib/sfb/logs
install -d -m 0755 -o "$SFB_RUNNER" -g "$SFB_RUNNER" /var/lib/sfb/skills
install -d -m 0750 -o root -g "$SFB_RUNNER" /etc/sfb

# ---------- Summary ----------
log "verifying tool versions"
{
  echo "OS      : $(. /etc/os-release && echo "$PRETTY_NAME")"
  echo "Arch    : $ARCH"
  echo "User    : $LOGIN_USER ($LOGIN_HOME)"
  echo "git     : $(git --version)"
  echo "gh      : $(gh --version | head -1)"
  echo "docker  : $(docker --version)"
  echo "compose : $($COMPOSE_BIN version 2>/dev/null | head -1 || echo missing)"
  echo "node    : $(node -v)"
  echo "npm     : $(npm -v)"
  echo "bun     : $(bun --version)"
  echo "claude  : $(claude --version 2>/dev/null || echo not-on-path)"
  echo "aws     : $(aws --version)"
  echo "psql    : $(psql --version)"
  echo "nginx   : $(nginx -v 2>&1)"
} | tee /tmp/sfb-bootstrap-versions.txt

log "done. next steps:"
cat <<NEXT
  1. relogin as $LOGIN_USER (or run 'newgrp docker') so docker group takes effect
  2. clone the repo:
       git clone https://github.com/shivang2000/sentry-fixer-bot.git /opt/sfb/current
  3. populate /etc/sfb/env (see docs/runbook.md)
  4. cd /opt/sfb/current && bun install --frozen-lockfile && bun run build
  5. install systemd units from deploy/systemd/ and start them
NEXT
