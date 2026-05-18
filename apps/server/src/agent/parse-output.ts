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
 *
 * The input may be either:
 *   - plain text (legacy `--print` mode), or
 *   - newline-delimited JSON from `--output-format stream-json`. In
 *     that case the assistant's final text lives in the `result` field
 *     of the last `type:"result"` event. We extract it first and run
 *     the same XML extractor over it.
 */
export function parseAgentOutput(stdout: string): AgentOutcome {
  const text = extractAssistantText(stdout);
  const tagMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (!tagMatch || tagMatch[1] === undefined) {
    return {
      summary: text.trim().slice(0, 2000),
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

/**
 * If `stdout` is JSONL stream-json output, scan it for the final
 * `type:"result"` event and return its `result` field — that's where
 * the assistant's final text lives. Falls back to the raw input on
 * legacy text-mode runs (where stdout is already the final text).
 *
 * Scan from the end of the stream because there's only one `result`
 * event and it's always last; this skips parsing every intermediate
 * `assistant`/`user` event when we only care about the final answer.
 *
 * Exported because reviewer.ts also needs to pull the final assistant
 * text out of its JSONL stream before applying the `<review>` regex.
 */
export function extractAssistantText(stdout: string): string {
  // Cheap guard: if there's no JSONL marker at all, treat as legacy.
  if (!stdout.includes('"type":"result"')) return stdout;
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; result?: string };
      if (ev.type === "result" && typeof ev.result === "string") return ev.result;
    } catch {
      // Non-JSON / corrupt line — keep scanning earlier lines.
    }
  }
  return stdout;
}
