# docker-test — local harness

Two ways to run alertforge in containers locally:

| Mode | Use when | Source | Iteration speed |
|---|---|---|---|
| **dev** | Hacking on the code | Bind-mounted from the host | edit → `restart` (fast) |
| **prod** | Smoke-testing the deployed shape | `git clone` of public main | edit → push → `--build` |

Both modes bring up an `amazonlinux:2023` container that mirrors a
fresh EC2 + a sidecar `postgres:16`. `setup.sh` runs in container mode
and `exec`s `bun apps/server/src/index.ts` as PID 1 so logs stream to
`docker compose logs -f`.

---

## Dev (recommended)

```bash
cd deploy/docker-test
docker compose -f docker-compose.dev.yml up --build
```

First boot ~3-5 min (image build + bun install + migrations + web
bundle). After that:

- **Edit any file under `apps/` or `packages/`** on the host → the
  bind-mounted source sees it instantly.
- To pick up backend code changes: `docker compose -f docker-compose.dev.yml restart alertforge`.
- To pick up new dependencies: stop the container, delete the
  `alertforge_dev_*` named volumes, `up --build` again.

Visit <http://localhost:3000>.

`DEPLOYMENT_MODE=local_trusted` auto-bootstraps a `local-board` admin —
no sign-up required; navigate straight to `/repos`, `/mcps`, `/chat`,
etc.

### Common dev tasks

```bash
# Tail server logs
docker compose -f docker-compose.dev.yml logs -f alertforge

# Open a shell inside the running container
docker compose -f docker-compose.dev.yml exec alertforge bash

# Re-run migrations after schema changes
docker compose -f docker-compose.dev.yml exec alertforge \
    bash -lc 'bun --filter=@alertforge/db db:migrate'

# Stop, keep DB volume
docker compose -f docker-compose.dev.yml down

# Stop + wipe everything (incl. DB volume)
docker compose -f docker-compose.dev.yml down -v
```

---

## Prod-shaped

```bash
cd deploy/docker-test
docker compose -f docker-compose.prod.yml up --build
```

This image clones the public repo at build time (commit pinned via the
`ALERTFORGE_REV` build-arg, defaults to `main`). Iteration cycle:

```bash
# Push a new commit to main, then force a fresh clone:
docker compose -f docker-compose.prod.yml build \
    --build-arg ALERTFORGE_REV=$(date +%s)
docker compose -f docker-compose.prod.yml up
```

In a real production deployment you'd switch
`DEPLOYMENT_MODE=authenticated` and terminate TLS upstream so
`PUBLIC_BASE_URL` is an `https://…` value. The local compose keeps
`local_trusted` so it boots without that infrastructure.

---

## Adding Anthropic / GitHub / Sentry credentials

Two options, same in both modes:

1. Add to the compose file's `environment:` block:
   ```yaml
   environment:
     ANTHROPIC_API_KEY: sk-ant-…
     GITHUB_APP_ID: "123456"
     GITHUB_APP_PRIVATE_KEY: |
       -----BEGIN RSA PRIVATE KEY-----
       …
   ```
   Then `docker compose -f docker-compose.dev.yml up`.

2. Once the Settings page (E12) ships, configure them via the UI —
   the container's `/etc/alertforge/env` is rewritten and the server picks up
   the change on next request.

---

## Files

| File | Purpose |
|---|---|
| `Dockerfile.dev` | Base image for dev mode (OS deps only; source bind-mounted) |
| `Dockerfile.prod` | Production-shaped image (clones from GitHub, bakes deps) |
| `docker-compose.dev.yml` | Dev mode orchestration |
| `docker-compose.prod.yml` | Prod-shaped orchestration |
| `README.md` | This file |
