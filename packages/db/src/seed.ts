/**
 * Idempotent seed for local dev: inserts a single demo `repos` row.
 * Run via `bun run db:seed` (script registered in package.json).
 */
import { createDb } from "./index";
import { repos } from "./schema/admin";

async function main(): Promise<void> {
  const db = createDb();
  await db
    .insert(repos)
    .values({
      sentryProject: "demo-app",
      github: "your-org/demo-app",
      defaultBranch: "main",
      testCommand: "bun test",
      prReviewers: ["your-org/eng"],
      dailyTokenCap: 1_000_000,
      dailyCostCapCents: 2500,
      minSeverityToFix: "medium",
    })
    .onConflictDoNothing({ target: repos.sentryProject });
  console.log("seed applied");
}

await main();
