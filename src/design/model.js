// Turns the raw output of the readTree snippet into a model the design tools format:
// absolute (screen-relative) bounds, children in order, component links, token values per theme,
// and clipping computed from geometry.

/** Values of a variable in every theme: [{ theme: "sang", value: "#fff" }, ...] or [{ value }]. */
export function tokenValues(variables, name) {
  const v = variables?.[name];
  if (!v) return null;
  if (!Array.isArray(v.value)) return [{ theme: null, value: v.value }];
  return v.value.map((e) => ({ theme: e.theme ? Object.values(e.theme)[0] : null, value: e.value }));
}

const isToken = (v) => typeof v === "string" && v.startsWith("$");

/** Merges subtree reads (the root read plus any split reads) into one model. */
export function buildModel(raw) {
  const nodes = new Map();
  for (const o of raw.nodes) nodes.set(o.id, { ...o, children: [] });
  const root = nodes.get(raw.root);
  if (!root) throw new Error(`node ${raw.root} was not found in the document`);
  for (const n of nodes.values()) {
    if (n.id !== root.id && n.parent && nodes.has(n.parent)) nodes.get(n.parent).children.push(n);
  }
  // Absolute bounds relative to the root (screen) frame; bounds from the engine are parent-relative.
  const place = (n, ox, oy) => {
    const b = n.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    n.abs = n === root ? { x: 0, y: 0, w: b.width, h: b.height } : { x: ox + b.x, y: oy + b.y, w: b.width, h: b.height };
    for (const c of n.children) place(c, n.abs.x, n.abs.y);
  };
  place(root, 0, 0);

  const componentOf = (id) => {
    const refs = raw.refs ?? {};
    const segs = id.split("/");
    const own = refs[id] ?? refs[segs.at(-1)];
    // An ancestor instance may have swapped this nested instance for another component.
    for (let i = 0; i < segs.length - 1; i++) {
      const swap = refs[segs.slice(0, i + 1).join("/")]?.[2]?.[segs.slice(i + 1).join("/")];
      if (swap) return { id: swap, name: raw.comps?.[swap] ?? swap, overrides: own?.[1] ?? [], swapped: true };
    }
    if (!own) return null;
    const [ref, overrides] = own;
    return { id: ref, name: raw.comps?.[ref] ?? ref, overrides: overrides ?? [] };
  };
  for (const n of nodes.values()) {
    n.component = componentOf(n.id);
    n.hidden = n.enabled === false;
  }

  // Clipping against the nearest ancestor that clips (screens usually do).
  const clipCheck = (n, clipRect) => {
    if (clipRect && n !== root && !n.hidden) {
      const a = n.abs, c = clipRect, eps = 0.5;
      const outside = a.x >= c.x + c.w - eps || a.y >= c.y + c.h - eps || a.x + a.w <= c.x + eps || a.y + a.h <= c.y + eps;
      const beyond = a.x < c.x - eps || a.y < c.y - eps || a.x + a.w > c.x + c.w + eps || a.y + a.h > c.y + c.h + eps;
      if (outside && a.w > 0 && a.h > 0) n.clipped = "fully";
      else if (beyond) n.clipped = "partially";
    }
    const next = n.clip ? intersect(clipRect, n.abs) : clipRect;
    for (const c of n.children) clipCheck(c, next);
  };
  clipCheck(root, null);

  return {
    root,
    nodes,
    skipped: raw.skipped ?? 0,
    variables: raw.variables ?? {},
    themes: raw.themes ?? {},
    token: (name) => tokenValues(raw.variables, name),
    isToken,
  };
}

function intersect(a, b) {
  if (!a) return { ...b };
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/** Name path of every node from the root, with [i] only where sibling names repeat. */
export function addresses(model) {
  const out = new Map();
  const duplicates = [];
  const walk = (n, prefix) => {
    const counts = {};
    for (const c of n.children) counts[c.name ?? c.type] = (counts[c.name ?? c.type] ?? 0) + 1;
    const seen = {};
    for (const c of n.children) {
      const base = c.name ?? c.type;
      let seg = base;
      if (counts[base] > 1) {
        seen[base] = (seen[base] ?? 0) + 1;
        seg = `${base}[${seen[base]}]`;
        if (seen[base] === 2) duplicates.push(`${prefix}/${base}`);
      }
      out.set(c.id, `${prefix}/${seg}`);
      walk(c, `${prefix}/${seg}`);
    }
  };
  const rootName = model.root.name ?? model.root.id;
  out.set(model.root.id, rootName);
  walk(model.root, rootName);
  return { addresses: out, duplicates };
}
