import { readFile } from "node:fs/promises";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { env } from "@sentry-fixer-bot/env/server";

let cached: Octokit | null = null;
let cachedToken: { token: string; expiresAt: number } | null = null;

async function loadPrivateKey(): Promise<string> {
  if (!env.GITHUB_APP_PRIVATE_KEY_PATH) throw new Error("GITHUB_APP_PRIVATE_KEY_PATH missing");
  return readFile(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
}

export async function getInstallationOctokit(): Promise<Octokit> {
  if (cached) return cached;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_INSTALLATION_ID) {
    throw new Error("GitHub App env not configured");
  }
  const privateKey = await loadPrivateKey();
  cached = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    },
  });
  return cached;
}

/** Returns a short-lived installation token for git clone over HTTPS. */
export async function getInstallationToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const privateKey = await loadPrivateKey();
  const auth = createAppAuth({
    appId: env.GITHUB_APP_ID!,
    privateKey,
    installationId: env.GITHUB_APP_INSTALLATION_ID!,
  });
  const result = (await auth({ type: "installation" })) as { token: string; expiresAt: string };
  cachedToken = { token: result.token, expiresAt: new Date(result.expiresAt).getTime() };
  return result.token;
}
