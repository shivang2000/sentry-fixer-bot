import { env } from "@sentry-fixer-bot/env/server";

export type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/**
 * Spawn Claude Code CLI headlessly inside a per-run workspace.
 * Uses --dangerously-skip-permissions since the worktree is isolated.
 */
export async function spawnClaudeAgent(input: {
  cwd: string;
  prompt: string;
  home?: string;
  mcpConfigPath?: string;
  timeoutSeconds?: number;
}): Promise<SpawnResult> {
  const args = [
    "--print",
    "--dangerously-skip-permissions",
    "--model",
    env.CLAUDE_MODEL,
    "--effort",
    "high",
  ];
  if (input.mcpConfigPath) {
    // `--mcp-config=<path>` form, not space-separated. claude's
    // arg parser eats the next positional with the space form which
    // means the prompt itself is misread as the config path.
    args.push(`--mcp-config=${input.mcpConfigPath}`);
  }
  args.push(input.prompt);

  const t0 = performance.now();
  const proc = Bun.spawn([env.CLAUDE_BIN, ...args], {
    cwd: input.cwd,
    env: {
      ...process.env,
      // Only forward ANTHROPIC_API_KEY when set. Forwarding "" wins
      // over claude's own ~/.claude/.credentials.json — operator runs
      // `claude auth login`, key file is fine, but the agent saw an
      // empty env var and treated itself as unauthenticated.
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      // Pin HOME to the state volume so the session creds resolve.
      // input.home wins if provided (per-run isolated home).
      HOME: input.home ?? `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = (input.timeoutSeconds ?? env.AGENT_TIMEOUT_SECONDS) * 1000;
  const timer = setTimeout(() => proc.kill("SIGTERM"), timeout);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return { exitCode, stdout, stderr, durationMs: performance.now() - t0 };
}
