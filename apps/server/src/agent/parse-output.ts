export type AgentOutcome = {
  summary: string;
  confidence: "low" | "medium" | "high" | "unknown";
  risk: "low" | "medium" | "high" | "unknown";
};

/**
 * Parse the agent's <summary>...</summary> envelope.
 * Tolerates missing or malformed envelopes by returning "unknown" markers.
 */
export function parseAgentOutput(stdout: string): AgentOutcome {
  const tagMatch = stdout.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (!tagMatch || tagMatch[1] === undefined) {
    return { summary: stdout.trim().slice(0, 2000), confidence: "unknown", risk: "unknown" };
  }
  const body = tagMatch[1].trim();
  const conf = extractField(body, "confidence");
  const risk = extractField(body, "risk");
  return {
    summary: body,
    confidence: normalizeLevel(conf),
    risk: normalizeLevel(risk),
  };
}

function extractField(body: string, name: string): string {
  const m = body.match(new RegExp(`"?${name}"?\\s*[:=]\\s*"?([a-z]+)"?`, "i"));
  return m?.[1] ?? "";
}

function normalizeLevel(v: string): "low" | "medium" | "high" | "unknown" {
  const lower = v.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high") return lower;
  return "unknown";
}
