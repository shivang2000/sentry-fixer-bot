#!/usr/bin/env bun
/**
 * Interactive Sentry setup. Spawned by /api/login/sentry through the
 * onboarding wizard. Reads two values from stdin (API token + org slug),
 * validates them against the Sentry API, writes them to the env file via
 * setEnvSecret (which also mutates process.env so the next health-check
 * tick flips the wizard pill green).
 *
 * Runs to completion + exits, so the wizard's InlineLoginSession sees
 * an `exit code 0` and triggers a setup.status refetch.
 */

import { setEnvSecret } from "@sentry-fixer-bot/api/secrets/env-file";

function write(s: string): void {
  process.stdout.write(s);
}

async function readLine(prompt: string): Promise<string> {
  write(prompt);
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let line = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return line;
      const chunk = decoder.decode(value);
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          write("\r\n");
          return line;
        }
        if (ch === "\x7f" || ch === "\b") {
          if (line.length > 0) {
            line = line.slice(0, -1);
            write("\b \b");
          }
          continue;
        }
        line += ch;
        write(ch);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

write("\r\n┌─ Sentry setup ─────────────────────────────────────────┐\r\n");
write("│ Paste your Sentry internal-integration API token and   │\r\n");
write("│ org slug. We verify by calling                         │\r\n");
write("│ GET /api/0/organizations/<slug>/ on sentry.io.         │\r\n");
write("└────────────────────────────────────────────────────────┘\r\n\r\n");

const token = (await readLine("API token (sk-...): ")).trim();
if (!token) {
  write("\x1b[31m✗ Empty token. Aborting.\x1b[0m\r\n");
  process.exit(2);
}
const org = (await readLine("Org slug (e.g. acme-corp): ")).trim();
if (!org) {
  write("\x1b[31m✗ Empty org slug. Aborting.\x1b[0m\r\n");
  process.exit(2);
}

write(`\r\nValidating against sentry.io/api/0/organizations/${org}/ ...\r\n`);

let ok = false;
let status = 0;
try {
  const res = await fetch(`https://sentry.io/api/0/organizations/${org}/`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  status = res.status;
  ok = res.ok;
} catch (err) {
  write(`\x1b[31m✗ Network error: ${err instanceof Error ? err.message : err}\x1b[0m\r\n`);
  process.exit(3);
}

if (!ok) {
  write(`\x1b[31m✗ Sentry rejected the credentials (HTTP ${status}).\x1b[0m\r\n`);
  write("  Double-check the token + slug at https://sentry.io/settings/.\r\n");
  process.exit(4);
}

write("\x1b[32m✓ Credentials accepted by Sentry.\x1b[0m\r\n");

await setEnvSecret("SENTRY_API_TOKEN", token);
await setEnvSecret("SENTRY_ORG_SLUG", org);
write("\x1b[32m✓ Wrote SENTRY_API_TOKEN + SENTRY_ORG_SLUG to /sfb/state/etc/env.\x1b[0m\r\n");
write("\r\nReturning to the wizard. The Sentry step should flip green within seconds.\r\n");
process.exit(0);
