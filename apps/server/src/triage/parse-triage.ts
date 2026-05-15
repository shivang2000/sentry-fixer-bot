export type TriageResult = {
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  suspectedFiles: string[];
};

export function parseTriageJson(text: string): TriageResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { severity: "medium", summary: "(unparseable)", suspectedFiles: [] };
  try {
    const obj = JSON.parse(match[0]) as Partial<TriageResult>;
    const severity = obj.severity ?? "medium";
    return {
      severity: (["low", "medium", "high", "critical"] as const).includes(
        severity as "low" | "medium" | "high" | "critical",
      )
        ? (severity as TriageResult["severity"])
        : "medium",
      summary: obj.summary ?? "",
      suspectedFiles: Array.isArray(obj.suspectedFiles) ? obj.suspectedFiles : [],
    };
  } catch {
    return { severity: "medium", summary: "(unparseable)", suspectedFiles: [] };
  }
}
