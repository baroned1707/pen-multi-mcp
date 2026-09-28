// The verify report as text for agents, and the contact sheet as an image for people.
import { crop, hstack, label, resize, strokeRect, vstack } from "./image.js";

const COLORS = { high: [220, 38, 38], medium: [234, 138, 0], low: [160, 160, 40] };
const GROUPS = ["Structure", "Layout", "Color", "Typography", "Visual"];

export function renderReport({ meta, summary, findings, notCompared = [], files = {}, hints = [], maxLines = 120 }) {
  const lines = [
    `# verify: ${meta.screen} (${meta.frameId}) vs ${meta.sourceLabel}`,
    `Viewport ${meta.viewport}${meta.theme ? ` · theme ${meta.theme}` : ""}${meta.width ? ` · design width ${meta.width}` : ""}`,
    `Verdict: ${summary.verdict === "match" ? "MATCH" : "DIFFERS"}${notCompared.length ? ` (not checked: ${notCompared.join(", ")})` : ""} — ${summary.high} high, ${summary.medium} medium, ${summary.low} low · matched ${summary.matched}/${summary.compared} design nodes (marker ${summary.by.marker}, text ${summary.by.text}, content ${summary.by.content ?? 0}, geometry ${summary.by.geometry}) · score ${summary.score === null ? "n/a (image only)" : `${summary.score}%`}`,
  ];
  if (notCompared.length) lines.push(`Not checked because the source does not provide them: ${notCompared.join(", ")}. A MATCH says nothing about these.`);
  let shown = 0;
  for (const g of GROUPS) {
    const list = findings.filter((f) => f.group === g);
    if (!list.length) continue;
    lines.push("", `## ${g}`);
    for (const f of list) {
      if (shown >= maxLines) break;
      const token = f.token ? ` Design token ${f.token.design}${f.token.code ? ` = ${f.token.code} in code` : ""}.` : "";
      lines.push(`${f.n}. [${f.severity}] ${f.message}${token}${f.code ? ` → ${f.code}` : ""}`);
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

/**
 * Close-ups of the worst findings with a box: the design crop and the UI crop side by side, each
 * with some margin, for up to `n` findings (high first). Returns [{ finding, image }].
 */
export function findingCrops({ designImg, uiImg, frame, findings, uiWidth = frame.w, n = 3, margin = 24, maxWidth = 900 }) {
  const k = designImg.width / frame.w;
  const ui = resize(uiImg, Math.round(uiWidth * k));
  const rank = { high: 0, medium: 1, low: 2 };
  const worst = findings.filter((f) => f.box && f.severity !== "low").sort((a, b) => rank[a.severity] - rank[b.severity] || a.n - b.n).slice(0, n);
  return worst.map((f) => {
    const b = { x: (f.box.x - margin) * k, y: (f.box.y - margin) * k, w: (f.box.w + 2 * margin) * k, h: (f.box.h + 2 * margin) * k };
    const pair = hstack([crop(designImg, b), crop(ui, b)]);
    return { finding: f, image: pair.width > maxWidth ? resize(pair, maxWidth) : pair };
  });
}

export function contactSheet(rows, maxWidth) {
  const sheet = vstack(rows, 24);
  return maxWidth && sheet.width > maxWidth ? resize(sheet, maxWidth) : sheet;
}

export { COLORS };
