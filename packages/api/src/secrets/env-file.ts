import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "@sentry-fixer-bot/env/server";
import { isValidEnvKey, shellQuote } from "./shell-quote";

const PROD_FILE = "/etc/sfb/env";
const DEV_FILE = "apps/server/.env.local";

function targetFile(): string {
  if (process.env.SFB_RUN_MODE === "container") {
    return process.env.SFB_ENV_FILE ?? "/sfb/state/etc/env";
  }
  return env.NODE_ENV === "production" ? PROD_FILE : DEV_FILE;
}

function shouldReloadSystemd(): boolean {
  return env.NODE_ENV === "production" && process.env.SFB_RUN_MODE !== "container";
}

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
    await reloadService();
  }
}

export function hasEnvSecret(key: string): boolean {
  if (!isValidEnvKey(key)) return false;
  const v = process.env[key];
  return typeof v === "string" && v.length > 0;
}

function reloadService(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("systemctl", ["reload-or-restart", "sfb-server.service"], { stdio: "pipe" });
    let stderr = "";
    p.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`systemctl reload-or-restart failed (${code}): ${stderr}`));
    });
  });
}
