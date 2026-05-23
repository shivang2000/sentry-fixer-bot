/**
 * Callback the consumer supplies to resolve a GitHub token for git
 * push + `gh` CLI auth. Injecting it keeps this step package free
 * of apps/server-internal imports; consumers pass their own
 * resolveGithubToken.
 */
export type ResolveGithubToken = () => Promise<string>;

export type OpenPrInput = {
  cwd: string;
  repo: string; // owner/name
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  isDraft: boolean;
  reviewers: string[];
  resolveToken: ResolveGithubToken;
};

export type OpenPrResult = { number: number; url: string };

/**
 * Open a PR via the `gh` CLI. Stages + commits any uncommitted
 * changes the agent made, pushes the branch, then opens the PR.
 *
 * Bundles commit-push + open-pr into one transactional flow because
 * the three sub-steps share state (cwd, branch, token) and must
 * succeed or fail together — splitting into separate PipelineStep
 * modules in P3c will mean writing each sub-step's progress to ctx
 * so a partial failure can be replayed.
 */
export async function openPr(input: OpenPrInput): Promise<OpenPrResult> {
  const token = await input.resolveToken();

  // Stage + commit any uncommitted changes the agent made
  await runStrict(input.cwd, ["git", "add", "-A"]);
  await runStrict(input.cwd, [
    "git",
    "-c",
    "user.email=alertforge@users.noreply.github.com",
    "-c",
    "user.name=alertforge",
    "commit",
    "-m",
    input.title,
  ]);

  // Push the branch
  await runStrict(input.cwd, ["git", "push", "-u", "origin", input.branch], {
    GITHUB_TOKEN: token,
  });

  // Open PR
  const args = [
    "gh",
    "pr",
    "create",
    "--title",
    input.title,
    "--body",
    input.body,
    "--base",
    input.baseBranch,
    "--head",
    input.branch,
  ];
  if (input.isDraft) args.push("--draft");
  for (const r of input.reviewers) {
    args.push("--reviewer", r);
  }
  const out = await runCapture(input.cwd, args, { GITHUB_TOKEN: token });
  const url = out.stdout.trim().split("\n").pop() ?? "";
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`gh pr create did not return a URL: ${out.stdout}\n${out.stderr}`);
  return { number: Number.parseInt(m[1] ?? "0", 10), url };
}

async function runStrict(
  cwd: string,
  argv: string[],
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exit !== 0) throw new Error(`${argv[0]} failed (${exit}): ${stderr}`);
}

async function runCapture(
  cwd: string,
  argv: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new Error(`${argv[0]} failed (${exit}): ${stderr}`);
  return { stdout, stderr };
}
