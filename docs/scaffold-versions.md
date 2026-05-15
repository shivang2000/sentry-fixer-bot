# Scaffold versions

Captured at scaffold time so future re-scaffolds can pin.

Generator: `create-better-t-stack@3.28.3`

Reproducible input: [`deploy/scaffold/bts-input.json`](../deploy/scaffold/bts-input.json)

Reproducible command:

```bash
bun create better-t-stack@latest create-json --input "$(cat deploy/scaffold/bts-input.json)"
```

## Installed package versions (at scaffold time)

```
bun: 1.3.5
create-better-t-stack: 3.28.3
scaffold timestamp: 2026-05-15T15:28:38.792Z
elapsed scaffold time (ms): 19903
```

## Root package.json catalog (truth source)

```json
{
  "dotenv": "^17.2.2",
  "zod": "^4.1.13",
  "typescript": "^6",
  "@types/bun": "^1.3.4",
  "hono": "^4.8.2",
  "@trpc/server": "^11.16.0",
  "better-auth": "1.6.9",
  "next-themes": "^0.4.6",
  "@trpc/client": "^11.16.0",
  "@types/react-dom": "^19.2.3"
}
```
