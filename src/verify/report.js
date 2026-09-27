// The verify report as text for agents, and the contact sheet as an image for people.
import { hstack, label, resize, strokeRect, vstack } from "./image.js";

const COLORS = { high: [220, 38, 38], medium: [234, 138, 0], low: [160, 160, 40] };
const GROUPS = ["Structure", "Layout", "Color", "Typography", "Visual"];

export function renderReport({ meta, summary, findings, notCompared = [], files = {}, hints = [], maxLines = 120 }) {
  const lines = [
    `# verify: ${meta.screen} (${meta.frameId}) vs ${meta.sourceLabel}`,
    `Viewport ${meta.viewport}${meta.theme ? ` · theme ${meta.theme}` : ""}${meta.width ? ` · design width ${meta.width}` : ""}`,
    `Verdict: ${summary.verdict === "match" ? "MATCH" : "DIFFERS"} — ${summary.high} high, ${summary.medium} medium, ${summary.low} low · matched ${summary.matched}/${summary.compared} design nodes (marker ${summary.by.marker}, text ${summary.by.text}, content ${summary.by.content ?? 0}, geometry ${summary.by.geometry}) · score ${summary.score === null ? "n/a (image only)" : `${summary.score}%`}`,
  ];
  if (notCompared.length) lines.push(`Not compared (the source does not provide them): ${notCompared.join(", ")}`);
  let shown = 0;
  for (const g of GROUPS) {
    const list = findings.filter((f) => f.group === g);
    if (!list.length) continue;
    lines.push("", `## ${g}`);
    for (const f of list) {
      if (shown >= maxLines) break;
      lines.push(`${f.n}. [${f.severity}] ${f.message}`);
      shown++;
    }
  }
  if (findings.length > shown) lines.push("", `… ${findings.length - shown} more findings in the JSON report.`);
  if (!findings.length) lines.push("", "No differences found.");
  if (hints.length) lines.push("", "## Hints", ...hints.map((h) => `- ${h}`));
  const written = Object.entries(files).filter(([, v]) => v);
  if (written.length) lines.push("", "## Files", ...written.map(([k, v]) => `- ${k}: ${v}`));
  if (summary.verdict !== "match") lines.push("", "Fix the high findings first (structure: missing, extra, order), then re-run verify with the same arguments.");
  return lines;
}

/**
 * One contact sheet row: the design render, the UI screenshot scaled to the design's width, and
 * the UI again with each finding's box and number (missing nodes are boxed on the design).
 */
export function sheetRow({ designImg, uiImg, frame, findings, uiWidth = frame.w }) {
  const k = designImg.width / frame.w;
  const ui = resize(uiImg, Math.round(uiWidth * k)); // same density as the design render, so boxes line up
  const design = { width: designImg.width, height: designImg.height, data: new Uint8Array(designImg.data) };
  const overlay = { width: ui.width, height: ui.height, data: new Uint8Array(ui.data) };
  for (const f of [...findings].reverse()) {
    if (!f.box) continue;
    const target = f.uiIndex === undefined && f.designId ? design : overlay;
    const b = { x: f.box.x * k, y: f.box.y * k, w: f.box.w * k, h: f.box.h * k };
    const color = COLORS[f.severity];
    strokeRect(target, b, color, Math.max(2, Math.round(k * 2)));
    label(target, b.x, Math.max(0, b.y - 7 * Math.max(2, Math.round(k * 1.5))), f.n, color, Math.max(2, Math.round(k * 1.5)));
  }
  return hstack([design, ui, overlay]);
}

export function contactSheet(rows, maxWidth) {
  const sheet = vstack(rows, 24);
  return maxWidth && sheet.width > maxWidth ? resize(sheet, maxWidth) : sheet;
}

export { COLORS };
