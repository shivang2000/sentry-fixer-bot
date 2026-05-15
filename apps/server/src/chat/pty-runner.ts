import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { env } from "@sentry-fixer-bot/env/server";

export type PtyHandle = {
  proc: ChildProcessWithoutNullStreams;
  write: (data: string) => void;
  kill: () => void;
};

/**
 * Spawn an interactive Claude Code subprocess for chat.
 *
 * On Linux we wrap with `script -q -c "<cmd>" /dev/null` so the child gets
 * a real TTY (Claude's CLI checks isatty and dumbs down output without it).
 * Bun.spawn ships a pty option in newer versions but is not stable enough
 * here to rely on. macOS `script(1)` has different flags; chat is only
 * supported on the Linux EC2 deployment.
 */
export function spawnClaudeInteractive(input: { cwd: string; prompt: string }): PtyHandle {
  const claudeCmd = `${env.CLAUDE_BIN} --dangerously-skip-permissions --model ${env.CLAUDE_MODEL}`;
  const proc = spawn("script", ["-q", "-c", claudeCmd, "/dev/null"], {
    cwd: input.cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  if (input.prompt) proc.stdin.write(`${input.prompt}\n`);
  return {
    proc,
    write: (data: string) => proc.stdin.write(data),
    kill: () => proc.kill("SIGTERM"),
  };
}
