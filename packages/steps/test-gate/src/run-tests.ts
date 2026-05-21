export type TestResult = { passed: boolean; stdout: string; stderr: string };

/**
 * Run the repo's test command in cwd. Splits the command on whitespace
 * (no shell). Tests run as the same user as the worker; sandbox via the
 * isolated worktree, not via uid/gid.
 */
export async function runRepoTests(input: {
  cwd: string;
  testCommand: string;
}): Promise<TestResult> {
  const argv = input.testCommand.split(/\s+/).filter(Boolean);
  if (argv.length === 0) return { passed: false, stdout: "", stderr: "empty test command" };

  const proc = Bun.spawn(argv, { cwd: input.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { passed: exit === 0, stdout, stderr };
}
