import { env } from "@alertforge/env/server";
import { parseTriageJson, type TriageResult } from "./parse-triage";

export type { TriageResult };
export { parseTriageJson };

const SYSTEM_PROMPT = `You triage production exception alerts. For each alert you receive, classify severity (low | medium | high | critical) and identify suspected file paths from the stack trace. Respond as JSON only: {"severity":"...","summary":"...","suspectedFiles":["path/to/file.ts"]}.`;

/**
 * Triage via the headless `claude` CLI. We prefer this over the
 * Anthropic SDK so the bot inherits whatever auth the operator
 * configured via `claude auth login` (no separate ANTHROPIC_API_KEY
 * required when on a subscription). HOME is pinned to the state
 * volume so `~/.claude/.credentials.json` resolves correctly.
 *
 * Falls back to ANTHROPIC_API_KEY env when set, in case the operator
 * pasted it instead of running auth login.
 */
export async function classify(input: {
  title: string;
  stackTrace: string;
}): Promise<TriageResult> {
  const stateHome = `${process.env.ALERTFORGE_STATE_DIR ?? "/alertforge/state"}/home`;
  const prompt = `${SYSTEM_PROMPT}\n\nTITLE:\n${input.title}\n\nSTACK:\n${input.stackTrace}`;

  const proc = Bun.spawn(
    [
      env.CLAUDE_BIN,
      "--print",
      "--dangerously-skip-permissions",
      "--model",
      env.CLAUDE_MODEL,
      prompt,
    ],
    {
      env: {
        ...process.env,
        HOME: stateHome,
        ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`claude triage exit ${exitCode}`);
  }
  return parseTriageJson(out);
}
