// Between the widths a design draws: what a layout that does not fit shows, found without a
// design to compare with — the page scrolling sideways, text cut or overlapping, targets too small
// to tap (touch widths, below 1024), and texts of the nearest design frame the page no longer shows.
import { normText } from "./match.js";

const r0 = (v) => Math.round(v);
const at = (b) => `${r0(b.w)}×${r0(b.h)} @${r0(b.x)},${r0(b.y)}`;
const who = (x) => `${x.marker ? `[data-pen="${x.marker}"] ` : ""}${x.selector ?? x.tag ?? "element"}${x.text ? ` "${String(x.text).slice(0, 40)}"` : ""}`;

/** The midpoints of neighbouring design widths: [390, 834, 1440] → [612, 1137]. */
export function betweenWidths(widths) {
  const ws = [...new Set(widths.map(Number).filter((w) => w > 0))].sort((a, b) => a - b);
  return ws.slice(1).map((w, k) => ({ width: Math.round((ws[k] + w) / 2), below: ws[k], above: w }));
}

/** The nearest design width to `w` (the smaller one on a tie: layouts break toward narrow). */
export function nearestWidth(widths, w) {
  return [...widths].map(Number).sort((a, b) => Math.abs(a - w) - Math.abs(b - w) || a - b)[0];
}

const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Findings for a page captured at a width no design frame has. `snapshot.responsive` comes from the
 * web adapter's probe; `nearest` is { name, width, texts } of the closest design frame, its texts
 * limited by the caller to those the page shows at that width.
 */
export function betweenFindings(snapshot, { nearest, touchBelow = 1024, minTarget = 24 } = {}) {
  const out = [];
  const p = snapshot.responsive ?? {};
  const vw = p.viewportW ?? snapshot.viewport?.w;
  if (p.scrollW > vw + 1) {
    const culprits = (p.overflow ?? []).sort((a, b) => b.right - a.right);
    out.push({
      severity: "high",
      kind: "overflow",
      message: `the page scrolls sideways: ${r0(p.scrollW)} wide in a ${r0(vw)} viewport.${culprits.length ? ` Past the right edge: ${culprits.slice(0, 5).map((c) => `${who(c)} to x ${c.right}`).join("; ")}${culprits.length > 5 ? "; …" : ""}.` : ""}`,
    });
  }
  for (const c of p.cut ?? []) {
    out.push({ severity: c.how === "ellipsis" ? "low" : "medium", kind: "cut", box: c.box, message: c.how === "ellipsis" ? `text shortened with an ellipsis: ${who(c)} at ${at(c.box)}.` : `text cut off: ${who(c)} at ${at(c.box)} is larger than its box, which hides the rest.` });
  }
  // Overlapping text: two text boxes covering each other, neither inside the other's element and
  // neither an overlay (fixed, sticky, absolute: badges and bars on purpose).
  const els = snapshot.elements ?? [];
  const byIndex = new Map(els.map((e) => [e.i, e]));
  const floating = (e) => {
    for (let cur = e, g = 0; cur && g < 100; cur = byIndex.get(cur.parent), g++) if (cur.fixed || cur.sticky || cur.absolute) return true;
    return false;
  };
  const related = (a, b) => {
    for (let cur = a, g = 0; cur && g < 100; cur = byIndex.get(cur.parent), g++) if (cur === b) return true;
    for (let cur = b, g = 0; cur && g < 100; cur = byIndex.get(cur.parent), g++) if (cur === a) return true;
    return false;
  };
  const texts = els.filter((e) => e.text && e.textBox && area(e.textBox) > 4 && !floating(e));
  let overlaps = 0;
  for (let i = 0; i < texts.length && overlaps < 10; i++) {
    for (let j = i + 1; j < texts.length && overlaps < 10; j++) {
      const a = texts[i], b = texts[j];
      if (related(a, b)) continue;
      const o = overlap(a.textBox, b.textBox);
      if (o > 0.3 * Math.min(area(a.textBox), area(b.textBox))) {
        overlaps++;
        out.push({ severity: "high", kind: "overlap", box: a.textBox, message: `texts overlap: "${String(a.text).slice(0, 40)}" at ${at(a.textBox)} and "${String(b.text).slice(0, 40)}" at ${at(b.textBox)}.` });
      }
    }
  }
  if (vw < touchBelow) {
    const small = (p.targets ?? []).filter((t) => t.box.w < minTarget || t.box.h < minTarget);
    for (const t of small.slice(0, 8)) out.push({ severity: "low", kind: "target", box: t.box, message: `small touch target: ${who(t)} is ${r0(t.box.w)}×${r0(t.box.h)} (under ${minTarget}×${minTarget}).` });
  }
  if (nearest?.texts?.length) {
    const shown = new Set(els.filter((e) => e.text).map((e) => normText(e.text)));
    const all = els.filter((e) => e.text).map((e) => normText(e.text)).join(" ");
    const missing = [...new Set(nearest.texts.map((t) => String(t).trim()).filter(Boolean))].filter((t) => {
      const n = normText(t);
      return n && !shown.has(n) && !all.includes(n);
    });
    if (missing.length) {
      out.push({ severity: "medium", kind: "structure", message: `${missing.length} text(s) of ${nearest.name} that the page shows at ${nearest.width} are gone at this width: ${missing.slice(0, 8).map((t) => `"${t.slice(0, 30)}"`).join(", ")}${missing.length > 8 ? ", …" : ""}. Hidden by a breakpoint that neither design has?` });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
