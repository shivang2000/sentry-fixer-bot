import type { DigestPayload, PipelineNotification } from "@alertforge/core";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderEmailSubject(n: PipelineNotification): string {
  if (n.status === "digest") {
    const triggerSuffix = n.alert?.title
      ? n.alert.title.replace(/^Daily digest\s*[—-]\s*/i, "")
      : n.triggerId;
    return `[Alertforge] Digest — ${triggerSuffix}`.slice(0, 200);
  }
  const sev = n.severity ? ` [${n.severity}]` : "";
  return `[Alertforge]${sev} ${n.alert.title}`.slice(0, 200);
}

export function renderEmailHtml(n: PipelineNotification): string {
  if (n.status === "digest") {
    return renderDigestHtml(n);
  }
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
  if (n.status === "digest") {
    return renderDigestText(n);
  }
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

// ---------- Digest variant ----------

function pctOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

function renderDigestHtml(n: PipelineNotification): string {
  const body: DigestPayload | undefined = n.digestBody;
  const title = n.alert?.title ?? "Alertforge digest";

  if (!body) {
    return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 8px 0;">${escapeHtml(title)}</h2>
  <p style="color:#a00;">Digest body missing — check the daily-digest cron logs.</p>
</body></html>`;
  }

  const merged = body.mergedClean + body.mergedWithEdits;
  const rowsHtml = [
    ["Alerts", String(body.alertCount)],
    ["PRs opened", String(body.fixesAttempted)],
    ["Merged clean", `${body.mergedClean} (${pctOf(body.mergedClean, body.fixesAttempted)}%)`],
    [
      "Merged with edits",
      `${body.mergedWithEdits} (${pctOf(body.mergedWithEdits, body.fixesAttempted)}%)`,
    ],
    [
      "Closed unmerged",
      `${body.closedUnmerged} (${pctOf(body.closedUnmerged, body.fixesAttempted)}%)`,
    ],
    ["Still open", `${body.open} (${pctOf(body.open, body.fixesAttempted)}%)`],
    ["Merge rate", `${pctOf(merged, body.fixesAttempted)}%`],
    [
      "Cost",
      `$${(body.costCents / 100).toFixed(2)} / $${(body.capCents / 100).toFixed(2)} (${pctOf(body.costCents, body.capCents)}%)`,
    ],
  ]
    .map(
      ([k, v]) =>
        `<tr><th align="left" style="padding:4px 12px 4px 0;color:#666;font-weight:500;">${escapeHtml(k!)}</th><td style="padding:4px 0;font-family:ui-monospace,monospace;">${escapeHtml(v!)}</td></tr>`,
    )
    .join("");

  const topRows =
    body.topFingerprints.length > 0
      ? body.topFingerprints
          .map(
            (fp, i) =>
              `<li><span style="font-family:ui-monospace,monospace;color:#666;">${i + 1}.</span> ${escapeHtml(fp.title)} <span style="color:#666;">×${fp.count} (${fp.closed} closed)</span></li>`,
          )
          .join("")
      : "";
  const topBlock =
    body.topFingerprints.length > 0
      ? `<h3 style="margin-top:24px;">Top recurring fingerprints</h3><ol style="line-height:1.7;">${topRows}</ol>`
      : "";

  const suggestedBlock = body.suggestedAction
    ? `<h3 style="margin-top:24px;">Suggested action</h3><p style="background:#fef3c7;padding:12px;border-radius:4px;">${escapeHtml(body.suggestedAction)}</p>`
    : "";

  const windowStr = `${body.windowStart.toISOString().slice(0, 10)} – ${body.windowEnd.toISOString().slice(0, 10)}`;

  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:16px;">
  <h2 style="margin:0 0 4px 0;">${escapeHtml(title)}</h2>
  <p style="color:#666;margin:0 0 16px 0;font-size:12px;">${escapeHtml(windowStr)} (last 7 days)</p>
  <table style="border-collapse:collapse;font-size:14px;">${rowsHtml}</table>
  ${topBlock}
  ${suggestedBlock}
  <hr style="border:none;border-top:1px solid #ddd;margin:24px 0;">
  <p style="color:#999;font-size:12px;">From Alertforge · daily digest</p>
</body></html>`;
}

function renderDigestText(n: PipelineNotification): string {
  const body: DigestPayload | undefined = n.digestBody;
  const title = n.alert?.title ?? "Alertforge digest";
  const lines: string[] = [];
  lines.push(title);
  if (!body) {
    lines.push("");
    lines.push("Digest body missing — check the daily-digest cron logs.");
    return lines.join("\n");
  }
  const merged = body.mergedClean + body.mergedWithEdits;
  const windowStr = `${body.windowStart.toISOString().slice(0, 10)} – ${body.windowEnd.toISOString().slice(0, 10)}`;
  lines.push(windowStr);
  lines.push("");
  lines.push(`Alerts:           ${body.alertCount}`);
  lines.push(`PRs opened:       ${body.fixesAttempted}`);
  lines.push(
    `  merged-clean:   ${body.mergedClean} (${pctOf(body.mergedClean, body.fixesAttempted)}%)`,
  );
  lines.push(
    `  merged-edits:   ${body.mergedWithEdits} (${pctOf(body.mergedWithEdits, body.fixesAttempted)}%)`,
  );
  lines.push(
    `  closed:         ${body.closedUnmerged} (${pctOf(body.closedUnmerged, body.fixesAttempted)}%)`,
  );
  lines.push(`  open:           ${body.open} (${pctOf(body.open, body.fixesAttempted)}%)`);
  lines.push("");
  lines.push(`Merge rate:       ${pctOf(merged, body.fixesAttempted)}%`);
  lines.push(
    `Cost:             $${(body.costCents / 100).toFixed(2)} / $${(body.capCents / 100).toFixed(2)} (${pctOf(body.costCents, body.capCents)}%)`,
  );
  if (body.topFingerprints.length > 0) {
    lines.push("");
    lines.push("Top recurring fingerprints:");
    body.topFingerprints.forEach((fp, i) => {
      lines.push(`  ${i + 1}. ${fp.title} ×${fp.count} (${fp.closed} closed)`);
    });
  }
  if (body.suggestedAction) {
    lines.push("");
    lines.push("Suggested action:");
    lines.push(`  ${body.suggestedAction}`);
  }
  lines.push("");
  lines.push("source: Alertforge daily digest");
  return lines.join("\n");
}
