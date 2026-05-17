export type AgentOutcome = {
  summary: string;
  problem: string;
  hypotheses: string;
  fix: string;
  confidence: "low" | "medium" | "high" | "unknown";
  risk: "low" | "medium" | "high" | "unknown";
  severity: "low" | "medium" | "high" | "critical" | "unknown";
};

/**
 * Parse the agent's <summary>...</summary> envelope.
 *
 * The agent is asked to emit a structured shape:
 *
 *   <summary>
 *     <problem>...</problem>
 *     <hypotheses>...</hypotheses>
 *     <fix>...</fix>
 *     <confidence>...</confidence>
 *     <risk>...</risk>
 *     <severity>...</severity>
 *   </summary>
 *
 * Tolerates missing / malformed envelopes — falls back to the raw
 * stdout for `summary` and "unknown" markers for the enums so the PR
 * still opens with whatever the agent produced.
 */
export function parseAgentOutput(stdout: string): AgentOutcome {
  const tagMatch = stdout.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (!tagMatch || tagMatch[1] === undefined) {
    return {
      summary: stdout.trim().slice(0, 2000),
      problem: "",
      hypotheses: "",
      fix: "",
      confidence: "unknown",
      risk: "unknown",
      severity: "unknown",
    };
  }
  const body = tagMatch[1].trim();
  return {
    summary: body,
    problem: extractSection(body, "problem"),
    hypotheses: extractSection(body, "hypotheses"),
    fix: extractSection(body, "fix"),
    confidence: normalizeLevel(extractInline(body, "confidence")),
    risk: normalizeLevel(extractInline(body, "risk")),
    severity: normalizeSeverity(extractInline(body, "severity")),
  };
}

function extractSection(body: string, tag: string): string {
  const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m?.[1]?.trim() ?? "";
}

/**
 * Match either `<tag>value</tag>` or the legacy `"tag": "value"` /
 * `tag = value` shapes earlier prompts produced. Keeps older runs
 * parseable while new ones use the XML form.
 */
function extractInline(body: string, tag: string): string {
  const xml = body.match(new RegExp(`<${tag}>\\s*([a-z]+)\\s*<\\/${tag}>`, "i"));
  if (xml?.[1]) return xml[1];
  const kv = body.match(new RegExp(`"?${tag}"?\\s*[:=]\\s*"?([a-z]+)"?`, "i"));
  return kv?.[1] ?? "";
}

function normalizeLevel(v: string): "low" | "medium" | "high" | "unknown" {
  const lower = v.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high") return lower;
  return "unknown";
}

function normalizeSeverity(v: string): "low" | "medium" | "high" | "critical" | "unknown" {
  const lower = v.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high" || lower === "critical") {
    return lower;
  }
  return "unknown";
}
