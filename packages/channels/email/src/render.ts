import type { PipelineNotification } from "@alertforge/core";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderEmailSubject(n: PipelineNotification): string {
  const sev = n.severity ? ` [${n.severity}]` : "";
  return `[Alertforge]${sev} ${n.alert.title}`.slice(0, 200);
}

export function renderEmailHtml(n: PipelineNotification): string {
  const sev = n.severity ?? "medium";
  const costLine =
    n.costCents !== undefined ? `<p>Cost: $${(n.costCents / 100).toFixed(2)}</p>` : "";
  const prButton = n.prUrl
    ? `<p><a href="${escapeHtml(n.prUrl)}" style="display:inline-block;padding:8px 16px;background:#2563eb;color:white;text-decoration:none;border-radius:4px;">Open PR</a></p>`
    : "";
  const triageBlock = n.triageSummary
    ? `<h3>Triage</h3><p style="white-space:pre-wrap;">${escapeHtml(n.triageSummary)}</p>`
    : "";

  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 8px 0;">${escapeHtml(n.alert.title)}</h2>
  <p style="color:#666;margin:0 0 16px 0;">
    <strong>${escapeHtml(n.status)}</strong> · severity ${escapeHtml(sev)}
    ${n.confidence !== undefined ? ` · confidence ${Math.round(n.confidence * 100)}%` : ""}
  </p>
  ${prButton}
  ${triageBlock}
  ${costLine}
  <hr style="border:none;border-top:1px solid #ddd;margin:24px 0;">
  <p style="color:#999;font-size:12px;">
    From Alertforge · source ${escapeHtml(n.alert.sourceType)} / ${escapeHtml(n.alert.sourceProject)}
  </p>
</body></html>`;
}

export function renderEmailText(n: PipelineNotification): string {
  const lines: string[] = [];
  lines.push(`Alertforge — ${n.alert.title}`);
  lines.push("");
  lines.push(`Status:     ${n.status}`);
  lines.push(`Severity:   ${n.severity ?? "—"}`);
  if (n.confidence !== undefined) {
    lines.push(`Confidence: ${Math.round(n.confidence * 100)}%`);
  }
  if (n.costCents !== undefined) {
    lines.push(`Cost:       $${(n.costCents / 100).toFixed(2)}`);
  }
  if (n.prUrl) {
    lines.push("");
    lines.push(`PR: ${n.prUrl}`);
  }
  if (n.triageSummary) {
    lines.push("");
    lines.push("Triage:");
    lines.push(n.triageSummary);
  }
  lines.push("");
  lines.push(`source: ${n.alert.sourceType} / ${n.alert.sourceProject}`);
  return lines.join("\n");
}
