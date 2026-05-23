#!/usr/bin/env bash
# EC2 first-boot bootstrap for alertforge.
# Target: Ubuntu 24.04 LTS (arm64 or amd64). Run as root via cloud-init.

set -euxo pipefail

# --- Packages ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release \
  git build-essential pkg-config unzip \
  nginx certbot python3-certbot-nginx \
  postgresql-client \
  unattended-upgrades

# --- Docker (postgres runs in docker-compose locally) ---
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# --- Bun runtime (installed to /usr/local/bin so systemd can find it) ---
ALERTFORGE_USER=alertforge-runner
useradd --system --create-home --shell /bin/bash "$ALERTFORGE_USER" || true
runuser -u "$ALERTFORGE_USER" -- bash -c 'curl -fsSL https://bun.sh/install | bash'
install -m 0755 "/home/${ALERTFORGE_USER}/.bun/bin/bun" /usr/local/bin/bun

# --- gh CLI ---
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
  https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update -y
apt-get install -y gh

# --- AWS CLI v2 ---
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp/awscli
/tmp/awscli/aws/install --update
rm -rf /tmp/awscli /tmp/awscliv2.zip

# --- Claude Code CLI ---
runuser -u "$ALERTFORGE_USER" -- bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
install -m 0755 "/home/${ALERTFORGE_USER}/.local/bin/claude" /usr/local/bin/claude || true

# --- App dirs ---
install -d -o "$ALERTFORGE_USER" -g "$ALERTFORGE_USER" /opt/alertforge /var/lib/alertforge /var/lib/alertforge/work /etc/alertforge
chmod 0750 /etc/alertforge

# --- Postgres via docker-compose ---
# Operator will clone the repo into /opt/alertforge/current and run db:start.

# --- Done ---
echo "userdata bootstrap complete; next: clone repo into /opt/alertforge/current, populate /etc/alertforge/env, then \`systemctl enable --now alertforge-server alertforge-worker alertforge-backup.timer\`"
