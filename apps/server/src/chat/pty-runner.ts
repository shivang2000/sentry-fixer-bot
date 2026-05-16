import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { env } from "@sentry-fixer-bot/env/server";

export type PtyHandle = {
  proc: ChildProcessWithoutNullStreams;
  write: (data: string) => void;
  kill: () => void;
};

/**
 * Spawn an arbitrary command inside a PTY (via util-linux `script(1)`) so the
 * child gets a real TTY. The chat + login routes both use this. macOS
 * `script(1)` has different flags; this code path is Linux-only — chat and
 * login flows are documented as Linux-only and the dev compose runs in an
 * amazonlinux:2023 container.
 */
export function spawnPtyCommand(input: {
  cmd: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
}): PtyHandle {
  const quoted = [input.cmd, ...(input.args ?? [])]
    .map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a))
    .join(" ");
  const proc = spawn("script", ["-q", "-c", quoted, "/dev/null"], {
    cwd: input.cwd,
    // Wide COLUMNS so claude's setup-token URL doesn't wrap mid-string at
    // the default 80 chars — the OAuth-URL detector tokenizes on whitespace
    // and would otherwise stop at the wrap point.
    env: {
      COLUMNS: "200",
      LINES: "50",
      TERM: "xterm-256color",
      ...process.env,
      ...(input.env ?? {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  return {
    proc,
    write: (data: string) => proc.stdin.write(data),
    kill: () => proc.kill("SIGTERM"),
  };
}

/**
 * Spawn an interactive Claude Code subprocess for chat. Thin wrapper around
 * spawnPtyCommand kept for back-compat with chat-ws callers.
 */
export function spawnClaudeInteractive(input: { cwd: string; prompt: string }): PtyHandle {
  const args = ["--dangerously-skip-permissions", "--model", env.CLAUDE_MODEL];
  const handle = spawnPtyCommand({
    cmd: env.CLAUDE_BIN,
    args,
    cwd: input.cwd,
    env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "" },
  });
  if (input.prompt) handle.write(`${input.prompt}\n`);
  return handle;
}
