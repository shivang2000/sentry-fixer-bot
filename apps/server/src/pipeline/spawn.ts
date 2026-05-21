/**
 * Thin wrapper around `Bun.spawn` used by pipeline wrappers for git,
 * gh, and test commands. Centralising the spawn at this seam lets the
 * integration test inject a scripted version (see
 * apps/server/src/pipeline/__tests__/fixtures.ts `SpawnScript`) without
 * touching the underlying step packages, which still call Bun.spawn
 * directly in production.
 *
 * Two surfaces:
 *   - `runCommand(argv, opts)` — async wrapper that captures stdout +
 *     stderr + exit code. Used by wrappers that need to inspect output
 *     (commit-push, secret-scan).
 *   - `RunCommandFn` — type alias for the injectable signature. The
 *     deps-factory provides the production impl; tests pass a stub.
 */

export type RunCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RunCommandFn = (
  argv: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<RunCommandResult>;

/**
 * Default implementation. Used in production via the deps-factory.
 * Tests do NOT call this — they pass their own `RunCommandFn` into
 * the wrapper factories.
 */
export const runCommand: RunCommandFn = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};
