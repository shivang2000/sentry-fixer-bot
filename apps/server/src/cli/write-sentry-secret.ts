#!/usr/bin/env bun
/**
 * Tiny shim called by sentry-setup.sh after a successful sentry-cli login.
 * Receives the auth token + org slug as argv and writes both via the
 * server's setEnvSecret (file write + in-process mutation, so the next
 * health-check tick can flip the wizard pill without a restart).
 *
 *   bun run write-sentry-secret.ts <token> <org-slug>
 */
import { setEnvSecret } from "@sentry-fixer-bot/api/secrets/env-file";

const token = process.argv[2];
const org = process.argv[3];
if (!token || !org) {
  console.error("usage: write-sentry-secret.ts <token> <org-slug>");
  process.exit(64);
}

await setEnvSecret("SENTRY_API_TOKEN", token);
await setEnvSecret("SENTRY_ORG_SLUG", org);
console.log("✓ Wrote SENTRY_API_TOKEN + SENTRY_ORG_SLUG to /sfb/state/etc/env.");
