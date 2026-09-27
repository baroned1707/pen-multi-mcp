// Turns matched pairs into findings: what is missing or extra, what moved, and which colors and
// type differ, each with the design address, the UI locator, and expected vs actual values.
import { deltaE, flatten, parseColor, toHex } from "./color.js";
import { normText } from "./match.js";

export const DEFAULT_TOLERANCE = { position: 4, size: 4, sizeRatio: 0.05, color: 10, fontSize: 1, fontWeight: 100, lineHeight: 2, radius: 2 };
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const r1 = (v) => Math.round(v * 10) / 10;
const box = (b) => `${r1(b.w)}×${r1(b.h)} @${r1(b.x)},${r1(b.y)}`;

/** The color behind an element: its own background composited over its ancestors', then the page's. */
export function effectiveBg(el, byIndex, page = { r: 255, g: 255, b: 255, a: 1 }) {
  const layers = [];
  for (let cur = el, guard = 0; cur && guard < 200; cur = cur.parent !== undefined ? byIndex.get(cur.parent) : null, guard++) {
    const c = parseColor(cur.bg);
    if (c && c.a > 0) {
      layers.push(c);
      if (c.a >= 0.999) break;
    }
  }
  return layers.reduceRight((under, c) => flatten(c, under), page);
}

const label = (node) => `${node.address ?? node.name} (${node.id}${node.component ? `, ← ${node.component}` : ""})`;
const where = (el) => el.selector ?? el.marker ?? el.tag ?? `element ${el.i}`;

/**
 * Findings for one screen. `ui` is in design coordinates and has `elements` with `i`/`parent`.
 * `fields` lists which UI properties the source provides (others are not compared).
 */
export function compare(design, ui, matched, { tolerance = {}, fields, viewportW, viewportH } = {}) {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };
  const has = (f) => !fields || fields.includes(f);
  const byIndex = new Map(ui.elements.map((el) => [el.i, el]));
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const page = flatten(parseColor(ui.pageBg)?.a > 0 ? parseColor(ui.pageBg) : null) ?? { r: 255, g: 255, b: 255, a: 1 };
  const findings = [];
  const add = (f) => findings.push(f);

  // Structure: missing design nodes, extra UI text, section order.
  // A missing container reports its missing contents in one finding.
  const missing = new Set(matched.unmatchedDesign.map((n) => n.id));
  const within = (id) => design.nodes.filter((n) => n.ancestors?.includes(id));
  for (const node of matched.unmatchedDesign) {
    if (node.ancestors?.some((id) => missing.has(id))) continue;
    // A grouping frame (nothing painted) whose contents are all present is only a wrapper the code does not have.
    const inside = within(node.id);
    if (!node.fill && !node.stroke && node.kind !== "text" && node.kind !== "instance" && node.kind !== "icon" && inside.every((n) => matched.pairs.has(n.id))) {
      missing.delete(node.id);
      add({ severity: "low", group: "Structure", kind: "group", designId: node.id, address: node.address, box: node.box, message: `no element groups ${node.kind} "${node.name}" — ${label(node)}${inside.length ? `; its ${inside.length} compared nodes are all present` : " (it paints nothing)"}.` });
      continue;
    }
    const lost = matched.unmatchedDesign.filter((n) => n.ancestors?.includes(node.id));
    // As severe as the most important thing missing with it (a missing card hides missing texts).
    const sev = node.kind === "box" && lost.every((n) => n.kind === "box") ? "medium" : "high";
    const what = node.kind === "text" ? `text "${String(node.text).slice(0, 60)}"` : `${node.kind} "${node.name}"`;
    const texts = lost.filter((n) => n.kind === "text").map((n) => `"${String(n.text).slice(0, 30)}"`);
    const contents = lost.length ? ` Its ${lost.length} compared descendants are missing too${texts.length ? `, including the texts ${texts.slice(0, 6).join(", ")}${texts.length > 6 ? ", …" : ""}` : ""}.` : "";
    add({ severity: sev, group: "Structure", kind: "missing", designId: node.id, address: node.address, box: node.box, contains: lost.map((n) => n.id), message: `missing: ${what} — ${label(node)} at ${box(node.box)} has no counterpart in the UI${node.kind === "text" ? " (no element shows this text)" : ""}.${contents}` });
  }
  const designTexts = new Set(design.nodes.filter((n) => n.kind === "text").map((n) => normText(n.text)));
  const extras = matched.unmatchedUi.filter((el) => normText(el.text) && !designTexts.has(normText(el.text))).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  for (const el of extras.slice(0, 8)) {
    add({ severity: "high", group: "Structure", kind: "extra", uiIndex: el.i, box: el.box, message: `extra: "${String(el.text).trim().slice(0, 60)}" at ${box(el.box)} (${where(el)}) is not in the design — leftover UI? Remove it or add it to the design.` });
  }
  if (extras.length > 8) {
    const rest = extras.slice(8);
    add({ severity: "high", group: "Structure", kind: "extra", message: `extra: ${rest.length} more texts not in the design, from y ${Math.round(rest[0].box.y)} down: ${rest.slice(0, 12).map((el) => `"${String(el.text).trim().slice(0, 30)}"`).join(", ")}${rest.length > 12 ? ", …" : ""}. Is this screen showing old UI, or the wrong state/route?` });
  }
  // Reading order on both sides (the design's layer order can be z-order in free layouts), with a
  // tolerance so side-by-side sections a pixel apart are ordered left to right.
  const reading = (box) => (a, b) => (Math.abs(box(a).y - box(b).y) <= tol.position ? box(a).x - box(b).x : box(a).y - box(b).y);
  const orderIds = design.order.filter((id) => matched.pairs.has(id)).sort(reading((id) => byId.get(id).box));
  if (orderIds.length > 1) {
    const uiOrder = [...orderIds].sort(reading((id) => matched.pairs.get(id).el.box));
    if (uiOrder.some((id, k) => id !== orderIds[k])) {
      const name = (id) => byId.get(id)?.name ?? id;
      add({ severity: "high", group: "Structure", kind: "order", message: `order: sections run ${orderIds.map(name).join(" → ")} in the design but ${uiOrder.map(name).join(" → ")} in the UI.` });
    }
  }

  // Per pair: content, layout, color, typography.
  for (const node of design.nodes) {
    const pair = matched.pairs.get(node.id);
    if (!pair) continue;
    const { el } = pair;
    const base = { designId: node.id, address: node.address, uiIndex: el.i, box: el.box };
    const who = `${label(node)} ↔ ${where(el)}`;

    if (node.kind === "text" && pair.how !== "text" && has("text")) {
      if (normText(el.text) !== normText(node.text)) {
        add({ ...base, severity: "high", group: "Structure", kind: "content", message: `text: "${String(el.text ?? "").trim().slice(0, 60)}" in the UI, "${String(node.text).slice(0, 60)}" in the design — ${who}.` });
      }
    }
    const flat = (t) => String(t ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (node.kind === "text" && has("text") && el.text && normText(el.text) === normText(node.text) && flat(el.text) !== flat(node.text)) {
      add({ ...base, severity: "low", group: "Typography", kind: "case", message: `letter case: "${flat(el.text).slice(0, 40)}" in the UI, "${flat(node.text).slice(0, 40)}" in the design — ${who}.` });
    }

    if (node.kind === "text" && el.truncated) {
      add({ ...base, severity: "medium", group: "Layout", kind: "truncated", message: `truncated: the UI cuts "${String(node.text).slice(0, 50)}" (ellipsis or line clamp) — the design shows it whole; give it the design's width/lines — ${who}.` });
    }

    // Layout. Text line boxes differ by platform, so texts compare their top-left (and width only when fixed).
    const d = node.box, u = el.box;
    const posTol = node.kind === "text" ? tol.position + 2 : tol.position;
    // Relative to the nearest matched ancestor: a child that moved with its parent is not reported again.
    const anc = (node.ancestors ?? []).map((id) => [byId.get(id), matched.pairs.get(id)]).find(([, p]) => p);
    const [ax, ay] = anc ? [anc[1].el.box.x - anc[0].box.x, anc[1].el.box.y - anc[0].box.y] : [0, 0];
    // A fixed/sticky bar sits against the viewport; a design frame taller than the viewport draws
    // it against the frame. Compare its distance from the bottom too.
    const fh = design.frame.h, vh = viewportH ?? fh;
    const dys = [u.y - d.y - ay];
    if (el.fixed) dys.push(u.y + u.h - vh - (d.y + d.h - fh));
    const dy = dys.reduce((best, v) => (Math.abs(v) < Math.abs(best) ? v : best));
    // Horizontally, a device wider or narrower than the frame keeps left-, right- or center-anchored
    // elements at the same margin, not the same x.
    const fw = design.frame.w, vw = viewportW ?? fw;
    const anchors = [u.x - d.x - ax, u.x + u.w - vw - (d.x + d.w - fw), u.x + u.w / 2 - vw / 2 - (d.x + d.w / 2 - fw / 2)];
    const dx = anchors.reduce((best, v) => (Math.abs(v) < Math.abs(best) ? v : best));
    const checkW = node.kind !== "text" || node.fixedWidth;
    const checkH = node.kind !== "text";
    const sizeTol = (v) => Math.max(tol.size, v * tol.sizeRatio);
    // Same left and right margins on a wider screen is a stretched (fill) element, not a size change.
    const stretched = Math.abs(u.x - d.x) <= tol.position && Math.abs(vw - (u.x + u.w) - (fw - (d.x + d.w))) <= tol.position;
    const dw = stretched ? 0 : u.w - d.w, dh = u.h - d.h;
    const big = (dv, v) => Math.abs(dv) > Math.max(8, v * 0.2);
    if ((checkW && big(dw, d.w)) || (checkH && big(dh, d.h))) {
      add({ ...base, severity: "high", group: "Layout", kind: "size", expected: d, actual: u, message: `size: ${r1(u.w)}×${r1(u.h)} in the UI, ${r1(d.w)}×${r1(d.h)} in the design — ${who}.` });
    } else if ((checkW && Math.abs(dw) > sizeTol(d.w)) || (checkH && Math.abs(dh) > sizeTol(d.h))) {
      add({ ...base, severity: "medium", group: "Layout", kind: "size", expected: d, actual: u, message: `size: ${r1(u.w)}×${r1(u.h)} in the UI, ${r1(d.w)}×${r1(d.h)} in the design (Δw ${r1(dw)}, Δh ${r1(dh)}) — ${who}.` });
    }
    if (Math.abs(dx) > posTol || Math.abs(dy) > posTol) {
      const rel = anc ? ` relative to ${anc[0].name}` : "";
      add({ ...base, severity: "medium", group: "Layout", kind: "position", expected: d, actual: u, message: `position: @${r1(u.x)},${r1(u.y)} in the UI, @${r1(d.x)},${r1(d.y)} in the design (off by ${r1(dx)}, ${r1(dy)}${rel}) — ${who}.` });
    }

    // Color.
    if (node.fill && has("bg")) {
      const bg = effectiveBg(el, byIndex, page);
      const de = deltaE(node.fill, bg);
      if (de > tol.color) add({ ...base, severity: "medium", group: "Color", kind: "fill", message: `fill: ${toHex(bg)} in the UI, ${toHex(node.fill)} in the design (ΔE ${r1(de)}) — ${who}.` });
    }
    if (node.color && has("fg")) {
      const fg = parseColor(el.fg);
      if (fg) {
        const de = deltaE(node.color, fg);
        if (de > tol.color) add({ ...base, severity: "medium", group: "Color", kind: node.type === "icon" ? "icon-color" : "text-color", message: `${node.type === "icon" ? "icon" : "text"} color: ${toHex(fg)} in the UI, ${toHex(node.color)} in the design (ΔE ${r1(de)}) — ${who}.` });
      }
    }
    if (node.stroke && has("border")) {
      const bw = el.borderWidth ?? 0;
      if (bw <= 0) add({ ...base, severity: "low", group: "Color", kind: "border", message: `border: none in the UI, ${node.strokeWidth}px ${toHex(node.stroke)} in the design — ${who}.` });
      else {
        const bc = parseColor(el.borderColor);
        if (bc && deltaE(node.stroke, bc) > tol.color) add({ ...base, severity: "low", group: "Color", kind: "border", message: `border color: ${toHex(bc)} in the UI, ${toHex(node.stroke)} in the design — ${who}.` });
      }
    }

    // Typography and shape.
    if (node.kind === "text") {
      if (node.fontSize && has("fontSize") && el.fontSize && Math.abs(el.fontSize - node.fontSize) > tol.fontSize) {
        add({ ...base, severity: "medium", group: "Typography", kind: "font-size", message: `font size: ${r1(el.fontSize)} in the UI, ${r1(node.fontSize)} in the design — ${who}.` });
      }
      if (node.fontWeight && has("fontWeight") && el.fontWeight && Math.abs(el.fontWeight - node.fontWeight) >= tol.fontWeight) {
        add({ ...base, severity: "medium", group: "Typography", kind: "font-weight", message: `font weight: ${el.fontWeight} in the UI, ${node.fontWeight} in the design — ${who}.` });
      }
      if (node.lineHeight && has("lineHeight") && el.lineHeight && Math.abs(el.lineHeight - node.lineHeight) > tol.lineHeight) {
        add({ ...base, severity: "low", group: "Typography", kind: "line-height", message: `line height: ${r1(el.lineHeight)} in the UI, ${r1(node.lineHeight)} in the design — ${who}.` });
      }
    }
    if (node.radius !== undefined && has("radius") && el.radius !== undefined) {
      const want = Math.min(node.radius, d.w / 2, d.h / 2), got = Math.min(el.radius, u.w / 2, u.h / 2);
      if (Math.abs(got - want) > tol.radius) add({ ...base, severity: "low", group: "Layout", kind: "radius", message: `corner radius: ${r1(got)} in the UI, ${r1(want)} in the design — ${who}.` });
    }
  }

  for (const miss of matched.markerMisses) {
    add({ severity: "low", group: "Structure", kind: "marker", uiIndex: miss.el.i, box: miss.el.box, message: `marker "${miss.value}" on ${where(miss.el)} names no node of this screen (typo, or the layer was renamed).` });
  }
  return findings;
}

export function sortFindings(findings) {
  const groups = ["Structure", "Layout", "Color", "Typography", "Visual"];
  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || groups.indexOf(a.group) - groups.indexOf(b.group));
}

/** Verdict, counts and score: the share of compared design nodes matched without any finding. */
export function summarize(design, matched, findings) {
  const flagged = new Set(findings.filter((f) => f.designId && f.severity !== "low").map((f) => f.designId));
  const clean = design.nodes.filter((n) => matched.pairs.has(n.id) && !flagged.has(n.id)).length;
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const how = { marker: 0, text: 0, content: 0, geometry: 0 };
  for (const p of matched.pairs.values()) how[p.how]++;
  return {
    verdict: count("high") || count("medium") ? "differs" : "match",
    high: count("high"),
    medium: count("medium"),
    low: count("low"),
    compared: design.nodes.length,
    matched: matched.pairs.size,
    by: how,
    score: design.nodes.length ? Math.round((clean / design.nodes.length) * 100) : 100,
  };
}
