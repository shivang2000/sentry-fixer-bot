import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { env } from "@sentry-fixer-bot/env/server";

export type PtyHandle = {
  proc: ChildProcessWithoutNullStreams;
  write: (data: string) => void;
  kill: () => void;
};

const DEFAULT_COLS = 140;
const DEFAULT_ROWS = 36;

/**
 * Spawn an arbitrary command inside a PTY allocated by util-linux script(1).
 * The chat WS and the /api/login WS both use this.
 *
 * script(1) gives the child a real controlling tty so claude / gh / etc.
 * pass their isatty() checks and render their interactive UI. We can't
 * pick the PTY's window size at the script(1) level (no such flag), so
 * we run `stty cols <C> rows <R>` *inside* the allocated PTY before
 * exec'ing the real command. That sets the slave tty's TIOCSWINSZ and
 * the child reads cols/rows from there.
 *
 * Live resize (browser-driven SIGWINCH) is not supported here —
 * script(1) doesn't proxy SIGWINCH and we don't hold the PTY fd. Cols
 * are fixed for the lifetime of the session; reconnect to change size.
 */
export function spawnPtyCommand(input: {
  cmd: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}): PtyHandle {
  const cols = input.cols ?? DEFAULT_COLS;
  const rows = input.rows ?? DEFAULT_ROWS;
  const inner = [input.cmd, ...(input.args ?? [])]
    .map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a))
    .join(" ");
  // `exec` so claude becomes pid of the bash that script wraps — script
  // exits when claude exits and we get a clean `exit` event.
  const wrapped = `stty cols ${cols} rows ${rows}; exec ${inner}`;
  const proc = spawn("script", ["-q", "-c", wrapped, "/dev/null"], {
    cwd: input.cwd,
    env: {
      COLUMNS: String(cols),
      LINES: String(rows),
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
 * Spawn a login bash shell for the chat session. The user gets a real
 * SSH-style prompt: they can `claude`, `gh auth login`, `vim`, `ls`,
 * anything that's on PATH. claude is NOT launched automatically —
 * kiosk mode was too restrictive (no way to inspect creds, install
 * MCPs, edit files, run agent dry-runs).
 *
 * The shell inherits the env file's HOME (= /sfb/state/home in
 * container mode) so any dotfile the user creates (.bash_history,
 * .claude/, .config/gh/, future .codex/.opencloud/) survives a
 * crash + container recreate.
 */
export function spawnClaudeInteractive(input: {
  cwd: string;
  prompt: string;
  cols?: number;
  rows?: number;
}): PtyHandle {
  const handle = spawnPtyCommand({
    cmd: "/bin/bash",
    args: ["--login"],
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    env: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
      // PS1 is unset under non-interactive bash; force it so the user
      // sees a real prompt the moment the shell starts.
      PS1: "\\[\\e[36m\\][sfb \\W]\\[\\e[0m\\]\\$ ",
    },
  });
  if (input.prompt) handle.write(`${input.prompt}\n`);
  return handle;
}
