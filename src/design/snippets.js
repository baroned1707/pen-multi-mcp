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
const scanRaw = (id) => Get(id, (n) => { if (n.type === "ref") refs[n.id] = [n.ref, Object.keys(n.descendants || {})]; if (n.reusable) comps[n.id] = n.name; return undefined; });
scanRaw(ROOT);
const scanned = new Set();
for (let more = true; more; ) {
  more = false;
  for (const [, [ref]] of Object.entries(refs)) {
    if (ref && !scanned.has(ref)) { scanned.add(ref); more = true; scanRaw(ref); }
  }
}
const nodes = [];
let skipped = 0;
Get(ROOT, (n, c) => {
  if (nodes.length >= ${maxNodes} || c.depth > ${maxDepth}) { skipped++; c.skipChildren(); return undefined; }
  const o = { id: n.id, parent: c.parentCtx ? c.parentCtx.node.id : null, depth: c.depth, bounds: c.bounds };
  for (const k of PROPS) if (n[k] !== undefined && n[k] !== null) o[k] = n[k];
  if (c.problems) o.problems = c.problems;
  nodes.push(o);
  return undefined;
}, { resolveInstances: true });
const byId = {};
for (const o of nodes) byId[o.id] = o;
Get(ROOT, (n) => {
  const o = byId[n.id];
  if (!o) return undefined;
  const r = {};
  for (const k of RESOLVED) if (n[k] !== undefined && JSON.stringify(n[k]) !== JSON.stringify(o[k])) r[k] = n[k];
  if (Object.keys(r).length) o.resolved = r;
  return undefined;
}, { resolveInstances: true, resolveVariables: true });
const v = GetVariables();
Print("TREE", JSON.stringify({ root: ROOT, nodes, skipped, refs, comps, variables: v.variables || {}, themes: v.themes || {} }));`;

/** Root nodes with their geometry and a light summary, for overview. */
export const readRoots = () => `const out = [];
Get((n, c) => {
  c.skipChildren();
  out.push({ id: n.id, type: n.type, name: n.name, reusable: !!n.reusable, theme: n.theme || null, placeholder: !!n.placeholder,
    content: n.type === "text" || n.type === "note" || n.type === "context" ? n.content : undefined, bounds: c.bounds });
  return undefined;
});
Print("ROOTS", JSON.stringify(out));`;
