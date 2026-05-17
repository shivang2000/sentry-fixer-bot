// Server-side `gh` CLI invoker. Unlike the user-facing system.runCommand
// allowlist, these are fixed argv arrays composed by the server — no
// untrusted input ever flows into argv positions, so no shell, no
// injection risk. We just spawn the binary directly via Bun.spawn.

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

async function gh(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stateHome = `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`;
  // Force HOME to the state-volume home. runuser/bash hand the bun
  // server process.env.HOME=/root in container mode, but `gh auth login`
  // (spawned via chat-ws.ts) writes its creds under our pinned
  // /sfb/state/home so reads have to match.
  const proc = BunRuntime.spawn(["gh", ...args], {
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

export type GhRepo = {
  nameWithOwner: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string | null;
  pushedAt: string | null;
};

export async function ghAuthStatus(): Promise<{ authenticated: boolean; account?: string }> {
  const res = await gh(["auth", "status"]);
  if (res.exitCode !== 0) return { authenticated: false };
  // gh prints "Logged in to github.com account <name>" on success.
  const match = res.stderr.concat(res.stdout).match(/account\s+([\w-]+)/i);
  return { authenticated: true, account: match?.[1] };
}

export async function ghListRepos(limit = 100): Promise<GhRepo[]> {
  const res = await gh([
    "repo",
    "list",
    "--limit",
    String(limit),
    "--json",
    "nameWithOwner,defaultBranchRef,isPrivate,description,pushedAt",
  ]);
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.slice(0, 500).replace(/\s+/g, " ").trim() || "gh_list_failed");
  }
  type Raw = {
    nameWithOwner: string;
    defaultBranchRef: { name: string } | null;
    isPrivate: boolean;
    description: string | null;
    pushedAt: string | null;
  };
  const raw: Raw[] = JSON.parse(res.stdout);
  return raw.map((r) => ({
    nameWithOwner: r.nameWithOwner,
    defaultBranch: r.defaultBranchRef?.name ?? "main",
    isPrivate: r.isPrivate,
    description: r.description,
    pushedAt: r.pushedAt,
  }));
}
