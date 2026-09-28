// A screen drawn several times (widths × themes × states) as one base frame plus, for each other
// frame, only what differs: nodes added or removed, and properties changed, matched by address.
import { describe } from "./inspect.js";
import { addresses } from "./model.js";

/**
 * The frame to show in full: the most common width, then a frame without a state, then the
 * matrix's own order (its first theme).
 */
export function pickBase(frames) {
  const count = new Map();
  for (const f of frames) count.set(String(f.width), (count.get(String(f.width)) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const order = new Map(frames.map((f, i) => [f, i]));
  return frames.filter((f) => String(f.width) === top).sort((a, b) => (a.row?.state ? 1 : 0) - (b.row?.state ? 1 : 0) || order.get(a) - order.get(b))[0];
}

// Address below the root, so frames with different names line up.
function byAddress(model) {
  const { addresses: addr } = addresses(model);
  const rootName = addr.get(model.root.id);
  const out = new Map();
  for (const n of model.nodes.values()) {
    if (n === model.root || n.hidden || [...ancestors(model, n)].some((a) => a.hidden)) continue;
    out.set(addr.get(n.id).slice(rootName.length), n);
  }
  return out;
}
function* ancestors(model, n) {
  for (let p = model.nodes.get(n.parent); p; p = model.nodes.get(p.parent)) yield p;
}

/**
 * A node's facts without its name, position and size (those follow from the layout). A width
 * equal to the screen's is written "screen", so a narrower frame does not list every full-width box.
 */
function facts(model, n, o) {
  const line = describe(model, n, o);
  const head = `${n.name ?? n.id} [`;
  const rest = line.slice(line.indexOf("] · ", head.length - 1) + 4); // names may contain " · "
  const screenW = String(Math.round(model.root.abs.w * 10) / 10);
  return rest
    .split(" · ")
    .slice(1)
    .map((f) => f.replace(new RegExp(`^w:${screenW.replace(".", "\\.")}(?= )`), "w:screen"));
}
const size = (m, keys) => keys.reduce((s, k) => s + [...m.keys()].filter((x) => x === k || x.startsWith(`${k}/`)).length, 0);

/**
 * How `other` differs from `base`: { added, removed, changed: [{ addr, from, to }], tokensOnly,
 * share } — tokensOnly when nothing differs but token values (a theme variant); share is the
 * fraction of nodes that differ.
 */
export function variantDiff(base, other) {
  const a = byAddress(base), b = byAddress(other);
  const onlyIn = (m, o) => {
    const keys = [...m.keys()].filter((k) => !o.has(k));
    // Report only the outermost node of an added/removed subtree.
    return keys.filter((k) => !keys.some((p) => p !== k && k.startsWith(`${p}/`)));
  };
  const added = onlyIn(b, a).map((k) => ({ addr: k, line: describe(other, b.get(k), { compact: true }) }));
  const removed = onlyIn(a, b).map((k) => ({ addr: k }));
  const changed = [];
  let valueOnly = 0;
  for (const [k, n] of a) {
    const m = b.get(k);
    if (!m) continue;
    const fullA = facts(base, n), fullB = facts(other, m);
    if (fullA.join("|") === fullB.join("|")) {
      if (facts(base, n, { compact: true }).join("|") !== facts(other, m, { compact: true }).join("|")) valueOnly++;
      continue;
    }
    const ca = facts(base, n, { compact: true }), cb = facts(other, m, { compact: true });
    changed.push({ addr: k, from: ca.filter((x) => !cb.includes(x)), to: cb.filter((x) => !ca.includes(x)) });
  }
  const total = Math.max(a.size, b.size, 1);
  // Whole added / removed subtrees count, so a new layout inside one new container is "large".
  const differing = size(b, added.map((x) => x.addr)) + size(a, removed.map((x) => x.addr)) + changed.length;
  return { added, removed, changed, tokensOnly: !added.length && !removed.length && !changed.length && valueOnly > 0, share: differing / total };
}

/** Lines for the "Variants" section of inspect. `others`: [{ frame, model }] */
export function variantLines(baseFrame, baseModel, others, { more, maxPer = 8, large = 0.5 } = {}) {
  const tag = (f) => `${f.name} (${f.id}, ${f.width}${f.theme ? `, ${f.theme}` : ""})`;
  const lines = [`## Variants (base above: ${tag(baseFrame)}; the others as differences from it)`];
  // A frame is compared with the frame of the same width in the base theme when there is one
  // (a dark 320 against the light 320), else with the base.
  const all = [{ frame: baseFrame, model: baseModel }, ...others];
  for (const { frame, model } of others) {
    // Among same-width frames in the base theme, the one whose name shares the most parts.
    const parts = (f) => new Set(f.name.split(/\s*[·—]\s*/));
    const overlap = (x) => [...parts(x.frame)].filter((p) => parts(frame).has(p)).length;
    const ref = frame.theme !== baseFrame.theme
      ? all.filter((x) => x.frame !== frame && String(x.frame.width) === String(frame.width) && x.frame.theme === baseFrame.theme).sort((x, y) => overlap(y) - overlap(x))[0] ?? null
      : null;
    const against = ref ?? { frame: baseFrame, model: baseModel };
    const vs = against.frame === baseFrame ? "" : ` (vs ${against.frame.id})`;
    const d = variantDiff(against.model, model);
    if (d.tokensOnly) {
      lines.push(`- ${tag(frame)}${vs}: same nodes and values; only token values differ (theme).`);
      continue;
    }
    const n = d.added.length + d.removed.length + d.changed.length;
    if (!n) {
      lines.push(`- ${tag(frame)}${vs}: same apart from positions and sizes.`);
      continue;
    }
    if (d.share > large) {
      lines.push(`- ${tag(frame)}${vs}: ${Math.min(100, Math.round(d.share * 100))}% of its nodes differ, too many to list as differences: ${more(frame.id)}`);
      continue;
    }
    // A theme variant should differ only through tokens; anything else is usually a mistake.
    const themeOnly = String(frame.width) === String(against.frame.width) && frame.theme !== against.frame.theme && !d.added.length && !d.removed.length;
    lines.push(`- ${tag(frame)}${vs}: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed${themeOnly ? " — ⚠ a theme variant with values not set through tokens" : ""}`);
    const detail = [
      ...d.added.map((x) => `  + ${x.addr} — ${x.line}`),
      ...d.removed.map((x) => `  - ${x.addr}`),
      ...d.changed.map((x) => `  ~ ${x.addr}: ${x.from.join(" · ") || "–"} → ${x.to.join(" · ") || "–"}`),
    ];
    lines.push(...detail.slice(0, maxPer));
    if (detail.length > maxPer) lines.push(`  … ${detail.length - maxPer} more: ${more(frame.id)}`);
  }
  return lines;
}
