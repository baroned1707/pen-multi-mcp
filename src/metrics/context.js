// Metrics of the context pen-multi hands to agents: how big it is, how much of it repeats, and
// whether every fact needed to build each node is in it. Pure functions; used by tests (as
// regression guards) and by bench/context.mjs (on real files).

/** A stable token estimate: UTF-8 bytes / 4 (the same proxy for every version compared). */
export const approxTokens = (s) => Math.ceil(Buffer.byteLength(s, "utf8") / 4);

/** Share of " · "-separated facts (after the name) that already appeared on an earlier line. */
export function redundancy(lines) {
  const seen = new Set();
  let total = 0, dup = 0;
  for (const l of lines) {
    for (const seg of l.trim().split(" · ").slice(1)) {
      total++;
      if (seen.has(seg)) dup++;
      else seen.add(seg);
    }
  }
  return total ? dup / total : 0;
}

const num = (v) => String(Math.round(v * 10) / 10);
// A value may be shown as its token, its resolved value, or both; any of them counts.
const spellings = (v, resolved) => [v, resolved].filter((x) => x !== undefined && x !== null && typeof x !== "object").map(String);

/**
 * What an implementer needs from a node (from toJson), each with the spellings that count as
 * present: { kind, needles: [...] }.
 */
export function factsOf(n) {
  const r = n.resolved ?? {};
  const out = [{ kind: "size", needles: [`${num(n.bounds.w)}×${num(n.bounds.h)}`] }];
  const add = (kind, v, res) => {
    const needles = spellings(v, res);
    if (needles.length) out.push({ kind, needles });
  };
  if (n.type === "text") {
    const t = n.text ?? {};
    if (t.content) out.push({ kind: "text", needles: [String(t.content).slice(0, 20)] });
    add("fontSize", t.fontSize, r.fontSize);
    add("fontWeight", t.fontWeight, r.fontWeight);
    add("color", n.fill, r.fill);
  } else if (n.type !== "icon") {
    add("fill", n.fill, r.fill);
  }
  add("radius", n.cornerRadius, r.cornerRadius);
  if (n.stroke !== undefined) add("stroke", n.stroke, r.stroke);
  if (n.gap !== undefined) add("gap", n.gap, r.gap);
  if (n.padding !== undefined) out.push({ kind: "padding", needles: (Array.isArray(n.padding) ? n.padding : [n.padding]).map(String) });
  if (n.component?.name) out.push({ kind: "component", needles: [n.component.name] });
  if (n.icon) out.push({ kind: "icon", needles: [`${n.icon.library ?? ""}:${n.icon.icon ?? ""}`] });
  return out;
}

/**
 * Recall of facts over the nodes the outline shows (lineOf: id -> line index). A fact counts when
 * any one of its spellings is on the node's line or in `defaults`; padding needs all its values. Nodes not shown (collapsed rows, depth or line limit) are counted apart.
 */
export function completeness({ lines, lineOf, nodes, defaults = "" }) {
  let facts = 0, present = 0, notShown = 0;
  const missing = [];
  for (const n of nodes) {
    if (!lineOf.has(n.id)) {
      notShown++;
      continue;
    }
    const line = lines[lineOf.get(n.id)] ?? "";
    for (const f of factsOf(n)) {
      facts++;
      const has = (s) => line.includes(s) || defaults.includes(s);
      const ok = f.kind === "padding" ? f.needles.every(has) : f.needles.some(has);
      if (ok) present++;
      else missing.push({ id: n.id, kind: f.kind });
    }
  }
  return { facts, present, recall: facts ? present / facts : 1, missing, notShown };
}
