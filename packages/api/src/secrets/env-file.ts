import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { env } from "@sentry-fixer-bot/env/server";
import { isValidEnvKey, shellQuote } from "./shell-quote";

const PROD_FILE = "/etc/sfb/env";
const DEV_FILE = "apps/server/.env.local";

function targetFile(): string {
  return env.NODE_ENV === "production" ? PROD_FILE : DEV_FILE;
}

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
    await reloadService();
  }
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
