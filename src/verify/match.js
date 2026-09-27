// Pairs design nodes with UI elements: markers first (exact), then equal text (nearest wins),
// then box overlap for the remaining shapes, instances and sections.

export const normText = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const stripIndex = (s) => s.replace(/\[\d+\]/g, "");
const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const dist = (a, b) => {
  const [ax, ay] = center(a), [bx, by] = center(b);
  return Math.hypot(ax - bx, ay - by);
};
export function iou(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}
const readingOrder = (a, b) => a.box.y - b.box.y || a.box.x - b.box.x;

/** The marker's value without its "pen:" prefix (and any Android package id before it). */
export function markerValue(raw) {
  if (!raw) return null;
  let v = String(raw).trim();
  const idx = v.indexOf(":id/");
  if (idx >= 0) v = v.slice(idx + 4);
  if (v.startsWith("pen:")) v = v.slice(4);
  return v || null;
}

/**
 * Design nodes a marker names: a node id; a full address; an address suffix ("Header/Title");
 * or a unique layer name. Repeated rows share a marker without an index ("List/Row").
 */
function resolveMarker(value, design, byId) {
  if (byId.has(value)) return [byId.get(value)];
  const exactIndex = /\[\d+\]/.test(value);
  const want = exactIndex ? value : stripIndex(value);
  const fits = (address) => {
    const a = exactIndex ? address : stripIndex(address ?? "");
    return a === want || a.endsWith(`/${want}`);
  };
  const byAddress = design.nodes.filter((n) => fits(n.address));
  if (byAddress.length) return byAddress;
  return design.nodes.filter((n) => n.name === value);
}

/**
 * Returns { pairs: Map(designId -> { el, how }), unmatchedDesign, unmatchedUi, markerMisses }.
 * `ui.elements` must already be in design coordinates.
 */
export function match(design, ui) {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const pairs = new Map();
  const usedUi = new Set();
  const take = (node, el, how) => {
    pairs.set(node.id, { el, how });
    usedUi.add(el.i);
  };
  const markerMisses = [];

  // 1. Markers, grouped so repeated markers pair with repeated design nodes in reading order.
  const groups = new Map();
  for (const el of ui.elements) {
    const v = markerValue(el.marker);
    if (!v) continue;
    const nodes = resolveMarker(v, design, byId);
    if (!nodes.length) {
      // A marker on a wrapper the comparison skips is fine; one that names nothing is a typo or stale.
      const w = stripIndex(v);
      const known = design.nodeIds.has(v) || design.allNames.has(v) || [...design.addresses.values()].some((a) => stripIndex(a) === w || stripIndex(a).endsWith(`/${w}`));
      if (!known) markerMisses.push({ el, value: v });
      continue;
    }
    const key = nodes.map((n) => n.id).join(",");
    if (!groups.has(key)) groups.set(key, { nodes: [...nodes].sort(readingOrder), els: [] });
    groups.get(key).els.push(el);
  }
  for (const { nodes, els } of groups.values()) {
    els.sort(readingOrder);
    nodes.forEach((node, k) => {
      if (els[k] && !pairs.has(node.id)) take(node, els[k], "marker");
    });
  }

  // 2. Equal text, closest pairs first.
  const byText = new Map();
  for (const el of ui.elements) {
    const t = el.text && normText(el.text);
    if (t) byText.set(t, [...(byText.get(t) ?? []), el]);
  }
  const candidates = [];
  for (const node of design.nodes) {
    if (node.kind !== "text" || pairs.has(node.id)) continue;
    for (const el of byText.get(normText(node.text)) ?? []) if (!usedUi.has(el.i)) candidates.push({ node, el, d: dist(node.box, el.box) });
  }
  candidates.sort((a, b) => a.d - b.d);
  for (const c of candidates) if (!pairs.has(c.node.id) && !usedUi.has(c.el.i)) take(c.node, c.el, "text");

  // 3. Containers by content: a design container whose texts were matched maps to the UI element
  // enclosing those texts (their common ancestor, or the ancestor whose size is closest).
  const byIndex = new Map(ui.elements.map((el) => [el.i, el]));
  const chain = (el) => {
    const out = [];
    for (let cur = el, guard = 0; cur && guard < 500; cur = cur.parent !== undefined ? byIndex.get(cur.parent) : null, guard++) out.push(cur);
    return out;
  };
  const containers = design.nodes
    .filter((n) => n.kind !== "text" && !pairs.has(n.id))
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h); // innermost first, so outer ones skip what inner ones took
  for (const node of containers) {
    const inner = design.nodes.filter((t) => t.kind === "text" && t.ancestors?.includes(node.id) && pairs.get(t.id));
    if (!inner.length) continue;
    const chains = inner.map((t) => chain(pairs.get(t.id).el));
    const common = chains[0].filter((el) => chains.every((c) => c.includes(el)));
    const area = node.box.w * node.box.h;
    let best = null;
    for (const el of common) {
      if (usedUi.has(el.i)) continue;
      const ratio = (el.box.w * el.box.h) / area;
      if (ratio < 0.5 || ratio > 2) continue;
      const score = Math.abs(Math.log(ratio));
      if (!best || score < best.score) best = { el, score };
    }
    if (best) take(node, best.el, "content");
  }

  // 4. Box overlap for the rest (not texts: a text found nowhere is missing, not "somewhere near").
  // On a device wider than the frame, right- and center-anchored boxes shift; try each anchor.
  const extra = (ui.viewportW ?? design.frame.w) - design.frame.w;
  const shifts = extra ? [0, extra, extra / 2] : [0];
  const overlaps = [];
  for (const node of design.nodes) {
    if (node.kind === "text" || pairs.has(node.id)) continue;
    for (const el of ui.elements) {
      if (usedUi.has(el.i)) continue;
      const score = Math.max(...shifts.map((sx) => iou({ ...node.box, x: node.box.x + sx }, el.box)), extra ? iou({ ...node.box, w: node.box.w + extra }, el.box) : 0);
      if (score >= 0.6) overlaps.push({ node, el, score });
    }
  }
  overlaps.sort((a, b) => b.score - a.score);
  for (const o of overlaps) if (!pairs.has(o.node.id) && !usedUi.has(o.el.i)) take(o.node, o.el, "geometry");

  return {
    pairs,
    unmatchedDesign: design.nodes.filter((n) => !pairs.has(n.id)),
    unmatchedUi: ui.elements.filter((el) => !usedUi.has(el.i)),
    markerMisses,
  };
}
