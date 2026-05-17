import { TRPCError } from "@trpc/server";

// Bun is a runtime-only global. The api package has @types/bun but the web
// app type-checks this file transitively through the workspace graph
// without those types. Access via globalThis cast so both type-check
// passes succeed without redeclaring (which would clash with @types/bun
// inside api's own tsc run).
type SpawnedProc = {
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};
type BunGlobal = {
  spawn(
    argv: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
    },
  ): SpawnedProc;
};
const BunRuntime = (globalThis as unknown as { Bun: BunGlobal }).Bun;

const ALLOWLIST = new Set(["npm", "npx", "pnpm", "bun", "git"]);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type RunResult = {
  cmd: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

/**
 * Split a shell-like command string into argv, respecting double + single
 * quotes. Does NOT expand globs, env vars, or backticks — we deliberately
 * never let the user's input near a shell. Anything that isn't a plain
 * word or a quoted string is treated as a literal character.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
    } else if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\" && i + 1 < input.length) {
        cur += input[i + 1];
        i += 1;
      } else cur += c;
    } else if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (/\s/.test(c)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
    } else cur += c;
    i += 1;
  }
  if (inSingle || inDouble) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "unclosed_quote" });
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function assertAllowed(argv: string[]): void {
  const head = argv[0];
  if (!head || !ALLOWLIST.has(head)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `command_not_allowlisted:${head ?? "<empty>"}`,
    });
  }
  if (head === "git" && argv[1] !== "clone") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "git_clone_only",
    });
  }
}

/**
 * Run an allowlisted package-manager command without going through a shell.
 * The args are passed directly to Bun.spawn so injection (e.g. `npm i pkg;
 * rm -rf /`) is structurally impossible — `;` shows up as an argument to
 * npm, which it rejects.
 *
 * Output is capped at 64 KB total; longer transcripts are truncated and
 * `truncated: true` is returned. Timeout 5 min.
 */
export async function runCommand(input: {
  command: string;
  cwd?: string;
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}): Promise<RunResult> {
  const argv = tokenize(input.command);
  if (argv.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "empty_command" });
  }
  assertAllowed(argv);

  const cwd = input.cwd ?? `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const proc = BunRuntime.spawn(argv, {
    cwd,
    env: {
      ...process.env,
      // Force npm to write into the state-volume cache so installs persist.
      NPM_CONFIG_CACHE: `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home/.npm`,
      HOME: `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`,
      ...(input.extraEnv ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, timeout);

  let stdoutBuf = "";
  let stderrBuf = "";
  let truncated = false;

  const collect = async (stream: ReadableStream<Uint8Array> | undefined, into: "out" | "err") => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      if (into === "out") {
        if (stdoutBuf.length + chunk.length > MAX_OUTPUT_BYTES) {
          stdoutBuf += chunk.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stdoutBuf.length));
          truncated = true;
        } else stdoutBuf += chunk;
      } else if (stderrBuf.length + chunk.length > MAX_OUTPUT_BYTES) {
        stderrBuf += chunk.slice(0, Math.max(0, MAX_OUTPUT_BYTES - stderrBuf.length));
        truncated = true;
      } else stderrBuf += chunk;
    }
  };

  await Promise.all([
    collect(proc.stdout as ReadableStream<Uint8Array>, "out"),
    collect(proc.stderr as ReadableStream<Uint8Array>, "err"),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(killer);

  return {
    cmd: argv[0] as string,
    args: argv.slice(1),
    exitCode,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    truncated,
  };
}
