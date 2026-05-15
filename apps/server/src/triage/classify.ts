import Anthropic from "@anthropic-ai/sdk";
import { env } from "@sentry-fixer-bot/env/server";

const TRIAGE_MODEL = "claude-haiku-4-5-20251001";

export type TriageResult = {
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  suspectedFiles: string[];
};

let cached: Anthropic | null = null;
function anthropic(): Anthropic {
  if (cached) return cached;
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
  cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cached;
}

const SYSTEM_PROMPT = `You triage production exception alerts. For each alert you receive, classify severity (low | medium | high | critical) and identify suspected file paths from the stack trace. Respond as JSON only: {"severity":"...","summary":"...","suspectedFiles":["path/to/file.ts"]}.`;

/** Haiku classification of an alert + stack trace. */
export async function classify(input: {
  title: string;
  stackTrace: string;
}): Promise<TriageResult> {
  const res = await anthropic().messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `TITLE:\n${input.title}\n\nSTACK:\n${input.stackTrace}` }],
  });

  const block = res.content.find((b) => b.type === "text");
  const text = block?.type === "text" ? block.text : "{}";
  return parseTriageJson(text);
}

export function parseTriageJson(text: string): TriageResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { severity: "medium", summary: "(unparseable)", suspectedFiles: [] };
  try {
    const obj = JSON.parse(match[0]) as Partial<TriageResult>;
    const severity = obj.severity ?? "medium";
    return {
      severity: ["low", "medium", "high", "critical"].includes(severity) ? severity : "medium",
      summary: obj.summary ?? "",
      suspectedFiles: Array.isArray(obj.suspectedFiles) ? obj.suspectedFiles : [],
    };
  } catch {
    return { severity: "medium", summary: "(unparseable)", suspectedFiles: [] };
  }
}
