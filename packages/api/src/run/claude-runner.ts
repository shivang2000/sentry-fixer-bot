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
  const stateHome = `${process.env.ALERTFORGE_STATE_DIR ?? "/alertforge/state"}/home`;
  // Force HOME to the state volume — bun's process.env.HOME is /root
  // in container mode (runuser sets it from /etc/passwd). The login
  // flow pins HOME=/alertforge/state/home explicitly when writing creds; the
  // status reader has to use the same path to find them.
  const proc = BunRuntime.spawn(["claude", ...args], {
    cwd: stateHome,
    env: { ...process.env, HOME: stateHome },
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

export type ClaudeUsageSnapshot = {
  /** `/usage` slash command output. Subscription/account status. */
  usage: string;
  /** `/extra-usage` output. Whether org has extra usage credits left. */
  extraUsage: string;
  /** `/context` output. Per-session token budget breakdown. */
  context: string;
  checkedAt: string;
};

/**
 * Run claude's `/usage`, `/extra-usage`, and `/context` slash commands
 * in `--print` mode and return their raw output. Used by /usage in the
 * UI to surface real-time quota state.
 *
 * Note: in `--print` mode the slash commands return only the textual
 * lines (no interactive TUI), so the answer is whatever claude itself
 * decides to print. We don't parse — let the UI render the raw text
 * verbatim so future CLI updates flow through without re-coding.
 *
 * Each call is bounded to 10s; a slow claude (no network) shouldn't
 * hang the request. Errors are surfaced as the snapshot string so the
 * UI can show "claude not authenticated" inline instead of failing.
 */
export async function claudeUsageSnapshot(): Promise<ClaudeUsageSnapshot> {
  const [usage, extraUsage, ctx] = await Promise.all([
    runSlash("/usage"),
    runSlash("/extra-usage"),
    runSlash("/context"),
  ]);
  return {
    usage,
    extraUsage,
    context: ctx,
    checkedAt: new Date().toISOString(),
  };
}

async function runSlash(cmd: string): Promise<string> {
  try {
    const res = await Promise.race([
      claude(["--print", cmd]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
    ]);
    if (res.exitCode !== 0) {
      return `(${cmd} exited ${res.exitCode}: ${res.stderr.trim().slice(0, 200)})`;
    }
    return res.stdout.trim();
  } catch (err) {
    return `(${cmd} failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}
