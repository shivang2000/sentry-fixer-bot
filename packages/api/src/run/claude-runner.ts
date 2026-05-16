// Server-side `claude` CLI invoker. Same shape as gh-runner — argv is
// composed by the server, never by user input, so no shell involvement.

type SpawnedProc = {
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  exited: Promise<number>;
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

async function claude(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stateHome = `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`;
  const proc = BunRuntime.spawn(["claude", ...args], {
    cwd: stateHome,
    env: { ...process.env, HOME: process.env.HOME ?? stateHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export type ClaudeAuthStatus = { loggedIn: boolean; account?: string; method?: string };

export async function claudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const res = await claude(["auth", "status"]);
  if (res.exitCode !== 0) return { loggedIn: false };
  // claude prints "Logged in as <account> via <method>" or similar.
  const combined = `${res.stdout}\n${res.stderr}`;
  const acc = combined.match(/(?:logged in as|account)[:\s]+([\w.@+-]+)/i);
  const method = combined.match(/via\s+([\w-]+)/i);
  return { loggedIn: true, account: acc?.[1], method: method?.[1] };
}

export type McpListEntry = { name: string; ok: boolean; raw: string };

/**
 * Parse `claude mcp list` output. The CLI's text format is:
 *   <name>: <command> - ✓ Connected
 *   <name>: <command> - ✗ Failed to connect
 * We return both a structured list + the raw transcript so the doctor
 * page can show it verbatim when our parser misses a format change.
 */
export async function claudeMcpList(): Promise<{ entries: McpListEntry[]; raw: string }> {
  const res = await claude(["mcp", "list"]);
  if (res.exitCode !== 0) {
    return { entries: [], raw: res.stderr || res.stdout };
  }
  const entries: McpListEntry[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.match(/^([\w@/.-]+):\s+(.+?)(?:\s+-\s+(✓|✗)\s+(.+))?$/);
    if (!m) continue;
    const [, name, , mark] = m;
    if (!name) continue;
    entries.push({ name, ok: mark === "✓", raw: line });
  }
  return { entries, raw: res.stdout };
}
