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

/**
 * `claude auth status` returns JSON like:
 *   {"loggedIn": true, "authMethod": "setup-token", "account": "you@x", ...}
 * or
 *   {"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}
 *
 * JSON.parse is the canonical reader — the older regex approach matched
 * the human-readable output that claude no longer prints by default and
 * always returned loggedIn:false for current claude versions.
 */
export async function claudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const res = await claude(["auth", "status"]);
  const text = (res.stdout || res.stderr).trim();
  if (!text) return { loggedIn: false };
  try {
    const parsed = JSON.parse(text) as {
      loggedIn?: boolean;
      authMethod?: string;
      account?: string;
      email?: string;
    };
    if (!parsed.loggedIn) return { loggedIn: false };
    return {
      loggedIn: true,
      account: parsed.account ?? parsed.email,
      method: parsed.authMethod,
    };
  } catch {
    // Fallback for any non-JSON future format. Exit 0 + non-empty output
    // with "logged in" anywhere is good enough to flip the pill.
    return res.exitCode === 0 && /logged in/i.test(text) ? { loggedIn: true } : { loggedIn: false };
  }
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
