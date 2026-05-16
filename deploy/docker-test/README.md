# docker-test — local end-to-end harness

Runs `setup.sh` inside an Amazon Linux 2023 container so you can exercise
the production install path without burning a real EC2.

## What you get

- An `amazonlinux:2023` container with every dep installed by
  `bootstrap-al2023.sh` (git, gh, docker CLI, nvm + Node LTS, npm, bun,
  claude CLI, AWS CLI, nginx, postgres-client).
- A sidecar `postgres:16` container.
- The repo COPY'd into the image, `bun install` baked at build time.
- `setup.sh` invoked at container start in **container mode**: skips
  systemd + nginx + the inside-container Postgres, runs migrations,
  builds the web bundle, then `exec`s `bun apps/server/src/index.ts` as
  the container's main process so logs stream to `docker compose logs -f`.

## Run it

```bash
cd deploy/docker-test
docker compose up --build
```

First boot takes ~5 minutes (image build + bun install + migrations +
web bundle). Subsequent `docker compose up` (no `--build`) is fast.

When you see:
```
sfb-test-app  | Listening on http://0.0.0.0:3000
```
open <http://localhost:3000>.

The first account you create at `/sign-up` becomes the instance admin.

## Stop / reset

```bash
docker compose down            # stop, keep postgres data
docker compose down -v         # stop + wipe the database volume
docker compose up --build -d   # detached
docker compose logs -f sfb     # tail the server
```

## When source changes

The source is baked into the image, not bind-mounted, so:

```bash
docker compose up --build
```

forces a rebuild with the latest code. Repeated rebuilds are cached
where possible (the bootstrap layer rarely changes).

## Configure Anthropic / GitHub / Sentry credentials

Two options:

1. **Edit `docker-compose.yml`** and add the keys under the `sfb` service's
   `environment:` block, then `docker compose up --build`.
2. **In the UI** (recommended once the Settings page ships): visit
   `/settings` and paste the keys. The container's `/etc/sfb/env` is
   ephemeral; rebuild to persist new defaults.
