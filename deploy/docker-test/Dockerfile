# Local test image for sentry-fixer-bot.
# Mirrors what a fresh Amazon Linux 2023 EC2 instance looks like after
# bootstrap-al2023.sh runs. Used by deploy/docker-test/docker-compose.yml
# to exercise setup.sh end-to-end without burning a real EC2.

FROM amazonlinux:2023

ARG SFB_REPO_URL=https://github.com/shivang2000/sentry-fixer-bot.git
ARG SFB_REPO_BRANCH=main
# Bump this (or pass --build-arg SFB_REV=$(date +%s)) to bust the cache and
# pull the latest commit from the repo when rebuilding.
ARG SFB_REV=main

# amazonlinux:2023 ships bash + curl-minimal preinstalled — enough to
# fetch and run bootstrap-al2023.sh, which installs everything else
# (git, gh, docker CLI, nvm + Node, npm, bun, claude, AWS CLI, nginx,
# postgres-client, jq, unzip, ...).
RUN curl -fsSL "https://raw.githubusercontent.com/shivang2000/sentry-fixer-bot/${SFB_REPO_BRANCH}/deploy/ec2/bootstrap-al2023.sh" -o /tmp/bootstrap.sh
RUN bash /tmp/bootstrap.sh && rm -f /tmp/bootstrap.sh

# Clone the repo into /opt/sfb/current as sfb-runner. The SFB_REV ARG
# invalidates this layer when you want a fresh pull.
RUN echo "rev=${SFB_REV}" \
    && install -d -o sfb-runner -g sfb-runner /opt/sfb \
    && runuser -u sfb-runner -- git clone --branch "${SFB_REPO_BRANCH}" --depth 50 "${SFB_REPO_URL}" /opt/sfb/current

WORKDIR /opt/sfb/current

# Install workspace dependencies as sfb-runner.
USER sfb-runner
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
RUN bun install --frozen-lockfile

USER root

ENV SFB_RUN_MODE=container \
    NODE_ENV=production

EXPOSE 3000

# Hand control to setup.sh — it detects SFB_RUN_MODE=container and skips
# systemd + nginx + the in-container postgres, then execs the server in
# the foreground as the container's main process so logs stream to
# `docker compose logs -f`.
CMD ["bash", "/opt/sfb/current/setup.sh"]
