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
  const args = ["--print", "--dangerously-skip-permissions", "--model", env.CLAUDE_MODEL];
  if (input.mcpConfigPath) {
    args.push("--mcp-config", input.mcpConfigPath);
  }
  args.push(input.prompt);

  const t0 = performance.now();
  const proc = Bun.spawn([env.CLAUDE_BIN, ...args], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
      ...(input.home ? { HOME: input.home } : {}),
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
