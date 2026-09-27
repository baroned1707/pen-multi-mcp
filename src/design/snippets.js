// Read-only execute snippets used by the design tools. Each prints one `LABEL <json>` line.

const PROPS = [
  "type", "name", "enabled", "reusable", "theme", "width", "height", "layout", "gap", "padding",
  "justifyContent", "alignItems", "layoutPosition", "clip", "fill", "stroke", "strokeWidth",
  "cornerRadius", "effect", "opacity", "content", "fontFamily", "fontSize", "fontWeight",
  "lineHeight", "letterSpacing", "textAlign", "textGrowth", "library", "icon", "slot",
];
// Properties whose resolved value (variables applied, in the node's theme) is worth keeping.
const RESOLVED = [
  "fill", "stroke", "strokeWidth", "cornerRadius", "gap", "padding", "fontFamily", "fontSize",
  "fontWeight", "lineHeight", "letterSpacing", "opacity", "effect", "content", "width", "height",
];

/**
 * Reads one subtree: raw instance -> component links (following nested components), the tree with
 * instances expanded and parent-relative bounds, resolved values, and the document's variables.
 * `maxNodes` caps the tree; nodes past it are counted, not read.
 */
export const readTree = (rootId, { maxNodes = 4000, maxDepth = 64 } = {}) => `const ROOT = ${JSON.stringify(rootId)};
const PROPS = ${JSON.stringify(PROPS)};
const RESOLVED = ${JSON.stringify(RESOLVED)};
const refs = {}, comps = {};
// An instance's descendants can swap a nested instance for another component ({ ref } or a whole
// { type: "ref" } replacement); keep those so the model reports the component actually shown.
const swaps = (d) => { const out = {}; for (const [k, v] of Object.entries(d || {})) if (v && v.ref) out[k] = v.ref; return out; };
const scanRaw = (id, limit) => Get(id, (n, c) => {
  if (c.depth > limit) { c.skipChildren(); return undefined; }
  if (n.type === "ref") {
    refs[n.id] = [n.ref, Object.keys(n.descendants || {}), swaps(n.descendants)];
    // A { type: "ref" } replacement gets its own id: link that id to its component directly.
    for (const v of Object.values(n.descendants || {})) if (v && v.id && v.ref) refs[v.id] = [v.ref, Object.keys(v.descendants || {}), swaps(v.descendants)];
  }
  if (n.reusable) comps[n.id] = n.name;
  return undefined;
});
scanRaw(ROOT, ${maxDepth});
const scanned = new Set();
for (let more = true; more; ) {
  more = false;
  for (const [, [ref, , sw]] of Object.entries(refs)) {
    for (const r of [ref, ...Object.values(sw || {})]) if (r && !scanned.has(r)) { scanned.add(r); more = true; scanRaw(r, 64); }
  }
}
const nodes = [];
let skipped = 0;
Get(ROOT, (n, c) => {
  if (c.depth > ${maxDepth}) { skipped++; c.skipChildren(); return undefined; }
  // Past the cap, stop descending too (visiting the rest is what gets reads interrupted);
  // the count is then a lower bound.
  if (nodes.length >= ${maxNodes}) { skipped++; c.skipChildren(); return undefined; }
  const o = { id: n.id, parent: c.parentCtx ? c.parentCtx.node.id : null, depth: c.depth, bounds: c.bounds };
  for (const k of PROPS) if (n[k] !== undefined && n[k] !== null) o[k] = n[k];
  if (c.problems) o.problems = c.problems;
  nodes.push(o);
  return undefined;
}, { resolveInstances: true });
const byId = {};
for (const o of nodes) byId[o.id] = o;
Get(ROOT, (n, c) => {
  const o = byId[n.id];
  if (!o) { c.skipChildren(); return undefined; }
  const r = {};
  for (const k of RESOLVED) if (n[k] !== undefined && JSON.stringify(n[k]) !== JSON.stringify(o[k])) r[k] = n[k];
  if (Object.keys(r).length) o.resolved = r;
  return undefined;
}, { resolveInstances: true, resolveVariables: true });
const v = GetVariables();
Print("TREE", JSON.stringify({ root: ROOT, nodes, skipped, refs, comps, variables: v.variables || {}, themes: v.themes || {} }));`;

/** Root nodes with geometry, text content, and path geometry for arrows, for overview. */
export const readRoots = () => `const out = [];
Get((n, c) => {
  c.skipChildren();
  out.push({ id: n.id, type: n.type, name: n.name, reusable: !!n.reusable, theme: n.theme || null,
    content: n.type === "text" || n.type === "note" || n.type === "context" ? n.content : undefined,
    geometry: n.type === "path" ? n.geometry : undefined, viewBox: n.type === "path" ? n.viewBox : undefined,
    bounds: c.bounds });
  return undefined;
}, { includePathGeometry: true });
const v = GetVariables();
Print("ROOTS", JSON.stringify({ roots: out, variables: v.variables || {}, themes: v.themes || {} }));`;

/**
 * Per-root statistics without expanding instances: instance counts per component, reusable nodes,
 * font sizes, spacing values, raw vs token fills, notes and label text inside frames.
 */
export const readStats = (ids) => statsOf(JSON.stringify(ids));

const statsOf = (idsExpr) => `const IDS = ${idsExpr};
const out = {};
for (const id of IDS) {
  const s = { nodes: 0, refs: {}, reusable: [], fontSizes: [], spacing: [], rawFills: {}, tokenFills: 0, notes: [], labels: [] };
  Get(id, (n, c) => {
    s.nodes++;
    if (n.type === "ref" && n.ref) s.refs[n.ref] = (s.refs[n.ref] || 0) + 1;
    if (n.reusable && c.depth > 0) s.reusable.push([n.id, n.name]);
    if (n.type === "text" && n.fontSize !== undefined) s.fontSizes.push(n.fontSize);
    if (n.gap !== undefined) s.spacing.push(n.gap);
    if (n.padding !== undefined) for (const p of [].concat(n.padding)) s.spacing.push(p);
    for (const f of [].concat(n.fill === undefined ? [] : n.fill)) {
      if (typeof f === "string") { if (f.startsWith("$")) s.tokenFills++; else s.rawFills[f] = (s.rawFills[f] || 0) + 1; }
    }
    if ((n.type === "note" || n.type === "context") && n.content) s.notes.push(String(n.content).slice(0, 300));
    return undefined;
  });
  out[id] = s;
}
Print("STATS", JSON.stringify(out));`;

/** readRoots and readStats for every root frame/group in one engine call (each ~330 ms). */
export const readOverviewAll = () => `{
${readRoots()}
}
{
${statsOf('Get((n, c) => { c.skipChildren(); return n.type === "frame" || n.type === "group" ? n.id : undefined; })')}
}`;
