import { readFile, rename, writeFile } from "node:fs/promises";
import { env } from "@sentry-fixer-bot/env/server";
import { isValidEnvKey, shellQuote } from "./shell-quote";

const PROD_FILE = "/etc/sfb/env";
const DEV_FILE = "apps/server/.env.local";

function targetFile(): string {
  return env.NODE_ENV === "production" ? PROD_FILE : DEV_FILE;
}

/**
 * Set or replace a key in the env file. Atomic via tmp+rename. In production
 * (NODE_ENV=production) we also `systemctl reload-or-restart sfb-server.service`
 * so the new value is in effect for the next spawn. In dev we skip systemctl.
 */
export async function setEnvSecret(key: string, value: string): Promise<void> {
  if (!isValidEnvKey(key)) throw new Error(`invalid env key: ${key}`);
  const file = targetFile();

  const existing = await readFile(file, "utf8").catch(() => "");
  const lines = existing.split("\n").filter((l) => l !== "" && !l.startsWith(`${key}=`));
  lines.push(`${key}=${shellQuote(value)}`);

  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
  await rename(tmp, file);

  if (env.NODE_ENV === "production") {
    await reloadServiceOrThrow();
  }
}

async function reloadServiceOrThrow(): Promise<void> {
  const proc = Bun.spawn(["systemctl", "reload-or-restart", "sfb-server.service"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`systemctl reload-or-restart failed (${exit}): ${err}`);
  }
}
