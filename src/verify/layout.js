// Code → design, layout: what a container must change for its children to sit where the UI draws
// them — gap, padding, order, fixed sizes, absolute positions — inferred from the matched
// children's boxes. One container change explains many position findings; only consistent
// evidence gives an edit (uneven gaps, wrapping or unmatched children give a reason instead).

const TOL = 1.5; // px: capture rounding and sub-pixel layout
const round = (v) => Math.round(v * 2) / 2;
const num = (v) => (typeof v === "number" ? v : null);

function paddingOf(n) {
  const p = n.resolved?.padding ?? n.padding;
  const v = Array.isArray(p) ? p.map((x) => num(x) ?? 0) : [num(p) ?? 0];
  if (v.length === 1) return [v[0], v[0], v[0], v[0]];
  if (v.length === 2) return [v[0], v[1], v[0], v[1]];
  return [v[0], v[1], v[2] ?? v[0], v[3] ?? v[1]];
}
const inInstance = (model, n) => {
  for (let p = n; p; p = model.nodes.get(p.parent)) if (p.component) return true;
  return false;
};
const under = (model, id, ancestor) => {
  for (let p = model.nodes.get(id); p; p = model.nodes.get(p.parent)) if (p.id === ancestor) return true;
  return false;
};

/**
 * Layout edits from matched pairs. `pairs`: Map(designId -> UI element, boxes in design units).
 * `spacing`: Map(value -> "$token") for gap / padding values. Returns { edits: [{ op, why,
 * node, explains: Set(designIds) }], notes: [string] }.
 */
export function layoutEdits(model, pairs, { spacing = new Map(), sizeTol = 4 } = {}) {
  const edits = [], notes = [];
  const q = JSON.stringify;
  const tok = (v) => spacing.get(v) ?? v;
  const lit = (v) => (typeof v === "string" ? q(v) : String(v)); // a token or a number
  const box = (n) => pairs.get(n.id)?.box;
  const descendants = (f) => new Set([...model.nodes.keys()].filter((id) => id !== f.id && under(model, id, f.id)));

  for (const f of model.nodes.values()) {
    if (f.type !== "frame" || f.hidden || inInstance(model, f)) continue;
    const kids = f.children.filter((c) => !c.hidden);
    if (!kids.length) continue;
    const lay = f.layout ?? "horizontal";
    const matched = kids.filter((k) => box(k));
    if (lay === "none") {
      // Absolute children: their offset from the container as the UI draws it.
      const fb = f === model.root ? { x: 0, y: 0 } : box(f);
      if (!fb) continue;
      for (const k of matched) {
        const kb = box(k);
        const x = round(kb.x - fb.x), y = round(kb.y - fb.y);
        const dx = x - (k.abs.x - f.abs.x), dy = y - (k.abs.y - f.abs.y);
        if (Math.abs(dx) > TOL || Math.abs(dy) > TOL) edits.push({ op: `Update(${q(k.id)}, { x: ${x}, y: ${y} })`, why: `${k.name ?? k.id} sits at ${x},${y} in ${f.name ?? f.id} in the UI`, node: k.id, explains: new Set([k.id, ...descendants(k)]) });
      }
      continue;
    }
    if (matched.length < kids.length) {
      if (matched.length >= 2) notes.push(`${f.name ?? f.id}: ${kids.length - matched.length} of its ${kids.length} children are not matched, so its gap and order are not inferred.`);
      continue;
    }
    const vertical = lay === "vertical";
    const a = vertical ? "y" : "x", s = vertical ? "h" : "w";
    // Order along the axis.
    const uiOrder = [...kids].sort((m, n) => box(m)[a] - box(n)[a]);
    if (uiOrder.some((k, i) => k !== kids[i])) {
      const moves = uiOrder.map((k, i) => `Move(${q(k.id)}, ${q(f.id)}, ${i})`).join("; ");
      edits.push({ op: moves, why: `the UI orders ${f.name ?? f.id}'s children ${uiOrder.map((k) => k.name ?? k.id).join(" → ")}`, node: f.id, explains: descendants(f) });
    }
    // Gap: consecutive children in the UI's order, evenly spaced (so one pass fixes order and gap).
    if (uiOrder.length >= 2) {
      const gaps = uiOrder.slice(1).map((k, i) => box(k)[a] - (box(uiOrder[i])[a] + box(uiOrder[i])[s]));
      const even = Math.max(...gaps) - Math.min(...gaps) <= TOL * 2;
      const uiGap = round(gaps.reduce((x, y) => x + y, 0) / gaps.length);
      const gap = num(f.resolved?.gap ?? f.gap) ?? 0;
      if (!even) notes.push(`${f.name ?? f.id}: its children are unevenly spaced in the UI (${gaps.map(round).join(", ")} px) — no single gap explains it.`);
      else if (Math.abs(uiGap - gap) > TOL) edits.push({ op: `Update(${q(f.id)}, { gap: ${lit(tok(uiGap))} })`, why: `${f.name ?? f.id}'s children are ${uiGap} px apart in the UI (gap ${gap} in the design)`, node: f.id, explains: new Set(uiOrder.slice(1).flatMap((k) => [k.id, ...descendants(k)])) });
    }
    // Leading padding: where the first child starts inside the container (start-aligned only).
    const fb = box(f);
    const start = !f.justifyContent || f.justifyContent === "start";
    const crossStart = !f.alignItems || f.alignItems === "start";
    if (fb && start) {
      const pad = paddingOf(f);
      const next = [...pad];
      const first = box(uiOrder[0]);
      const lead = round(first[a] - fb[a]);
      const li = vertical ? 0 : 3;
      if (Math.abs(lead - pad[li]) > TOL) next[li] = lead;
      if (crossStart) {
        const ca = vertical ? "x" : "y", ci = vertical ? 3 : 0;
        const cross = round(Math.min(...kids.map((k) => box(k)[ca])) - fb[ca]);
        if (Math.abs(cross - pad[ci]) > TOL) next[ci] = cross;
      }
      if (next.some((v, i) => v !== pad[i])) {
        edits.push({ op: `Update(${q(f.id)}, { padding: [${next.map((v) => lit(tok(v))).join(", ")}] })`, why: `${f.name ?? f.id}'s content starts ${lead} px in (${vertical ? "top" : "left"}) in the UI`, node: f.id, explains: descendants(f) });
      }
    }
  }
  // Fixed sizes that the UI draws otherwise (texts size themselves; fill/hug follow the layout).
  for (const n of model.nodes.values()) {
    if (n.hidden || n.type === "text" || inInstance(model, n) || n === model.root) continue;
    const b = box(n);
    if (!b) continue;
    const props = {};
    if (typeof n.width === "number" && Math.abs(b.w - n.width) > sizeTol) props.width = round(b.w);
    if (typeof n.height === "number" && Math.abs(b.h - n.height) > sizeTol) props.height = round(b.h);
    if (Object.keys(props).length) edits.push({ op: `Update(${q(n.id)}, { ${Object.entries(props).map(([k, v]) => `${k}: ${v}`).join(", ")} })`, why: `${n.name ?? n.id} is ${round(b.w)}×${round(b.h)} in the UI`, node: n.id, explains: new Set([n.id]) });
  }
  return { edits, notes };
}
