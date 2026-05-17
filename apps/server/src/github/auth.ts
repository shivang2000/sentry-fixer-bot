import { env } from "@sentry-fixer-bot/env/server";
import { getInstallationToken } from "./app-auth";

/**
 * Resolve a GitHub token for cloning + pushing + opening PRs.
 *
 * Preference order:
 *   1. GitHub App installation token — preferred for prod. Short-lived,
 *      scoped to the install, attributable to the bot account.
 *   2. `gh auth token` from the operator's gh CLI session — used in
 *      dev and on self-hosted single-tenant deployments where the
 *      operator ran `gh auth login` in the wizard.
 *
 * Throws when neither is available so the agent run records a clear
 * "no GitHub credentials" error rather than a cryptic git clone fail.
 */
export async function resolveGithubToken(): Promise<string> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return getInstallationToken();
  }
  const stateHome = `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`;
  const proc = Bun.spawn(["gh", "auth", "token"], {
    env: { ...process.env, HOME: stateHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exit !== 0 || !out.trim()) {
    throw new Error(
      "no GitHub credentials — configure GITHUB_APP_* in /settings or run `gh auth login` in the wizard",
    );
  }
  return out.trim();
}
