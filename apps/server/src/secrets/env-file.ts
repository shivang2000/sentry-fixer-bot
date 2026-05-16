import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "@sentry-fixer-bot/env/server";
import { isValidEnvKey, shellQuote } from "./shell-quote";

const PROD_FILE = "/etc/sfb/env";
const DEV_FILE = "apps/server/.env.local";

function targetFile(): string {
  if (process.env.SFB_RUN_MODE === "container") return "/etc/sfb/env";
  return env.NODE_ENV === "production" ? PROD_FILE : DEV_FILE;
}

function shouldReloadSystemd(): boolean {
  return env.NODE_ENV === "production" && process.env.SFB_RUN_MODE !== "container";
}

/**
 * Set or replace a key in the env file. Atomic via tmp+rename. In production
 * (NODE_ENV=production) we also `systemctl reload-or-restart sfb-server.service`
 * so the new value is in effect for the next spawn. In container mode
 * (SFB_RUN_MODE=container) we skip systemctl and rely on in-process mutation
 * of process.env — chat/agent subprocesses inherit the new env at spawn time.
 */
export async function setEnvSecret(key: string, value: string): Promise<void> {
  if (!isValidEnvKey(key)) throw new Error(`invalid env key: ${key}`);
  const file = targetFile();
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined);

  const existing = await readFile(file, "utf8").catch(() => "");
  const lines = existing.split("\n").filter((l) => l !== "" && !l.startsWith(`${key}=`));
  lines.push(`${key}=${shellQuote(value)}`);

  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
  await rename(tmp, file);

  process.env[key] = value;

  if (shouldReloadSystemd()) {
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
