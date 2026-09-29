// Design mutations for eval tasks: small, known changes to nodes verify compares, chosen by seed
// so a run can be repeated. Each returns what it did, to judge and to describe.
import { buildModel } from "../../../src/design/model.js";
import { readSubtree } from "../../../src/design/read.js";
import { designNodes } from "../../../src/verify/design.js";
import { call, text } from "../../../test/helpers.js";

export const KINDS = ["text", "color", "radius", "spacing", "hide", "add", "order"];

/** A seeded random generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

export const reader = (client, file) => async (input) => {
  const res = await call(client, "execute", { filePath: file, input });
  return { text: text(res), error: res.isError ? text(res) : null };
};

/** Candidate operations on a frame's model (pure; tested without the engine). */
export function candidates(model, variables = {}) {
  const d = designNodes(model);
  const compared = d.nodes.filter((n) => !n.insideInstance);
  const node = (id) => model.nodes.get(id);
  const colorTokens = Object.entries(variables).filter(([, v]) => v?.type === "color").map(([k]) => `$${k}`);
  const out = { text: [], color: [], radius: [], spacing: [], hide: [], add: [], order: [] };
  for (const n of compared) {
    const raw = node(n.id);
    if (n.kind === "text" && String(n.text).trim().length > 1) out.text.push({ id: n.id, address: n.address, from: n.text, to: `${n.text} (new)` });
    if (typeof raw?.fill === "string" && n.kind !== "icon") {
      const others = colorTokens.filter((t) => t !== raw.fill);
      if (others.length) out.color.push({ id: n.id, address: n.address, from: raw.fill, choices: others });
    }
    if (!["text", "icon", "instance"].includes(n.kind) && typeof raw?.cornerRadius === "number") out.radius.push({ id: n.id, address: n.address, from: raw.cornerRadius, to: raw.cornerRadius + 6 });
    if (n.kind === "text") out.add.push({ id: n.id, address: n.address, parent: raw?.parent, content: "Added label" });
    const parent = raw?.parent && node(raw.parent);
    if (parent && parent.children.filter((c) => !c.hidden).length > 1) out.hide.push({ id: n.id, address: n.address });
  }
  for (const f of model.nodes.values()) {
    if (f.type !== "frame" || f.hidden) continue; // the screen itself too: its sections can be reordered
    const kids = f.children.filter((c) => !c.hidden);
    const lay = f.layout ?? "horizontal";
    if (lay !== "none" && typeof f.gap === "number" && kids.length > 1) out.spacing.push({ id: f.id, name: f.name, from: f.gap, to: f.gap + 12 });
    if (lay !== "none" && kids.length > 1 && compared.some((n) => n.id === kids[0].id || n.id === kids[1].id)) out.order.push({ id: kids[1].id, parent: f.id, name: kids[1].name });
  }
  return out;
}

/** execute input for one chosen operation. */
export function operation(kind, c, r) {
  const q = JSON.stringify;
  switch (kind) {
    case "text": return { input: `Update(${q(c.id)}, { content: ${q(c.to)} })`, what: `text of ${c.address}: "${c.from}" → "${c.to}"` };
    case "color": {
      const to = pick(r, c.choices);
      return { input: `Update(${q(c.id)}, { fill: ${q(to)} })`, what: `color of ${c.address}: ${c.from} → ${to}` };
    }
    case "radius": return { input: `Update(${q(c.id)}, { cornerRadius: ${c.to} })`, what: `corner radius of ${c.address}: ${c.from} → ${c.to}` };
    case "spacing": return { input: `Update(${q(c.id)}, { gap: ${c.to} })`, what: `gap of ${c.name}: ${c.from} → ${c.to}` };
    case "hide": return { input: `Update(${q(c.id)}, { enabled: false })`, what: `${c.address} removed` };
    case "add": return { input: `Copy(${q(c.id)}, ${q(c.parent)}, { content: ${q(c.content)}, name: "Added" })`, what: `a text "${c.content}" added next to ${c.address}` };
    case "order": return { input: `Move(${q(c.id)}, ${q(c.parent)}, 0)`, what: `${c.name} moved first in its row/column` };
    default: throw new Error(`unknown mutation ${kind}`);
  }
}

/** Chooses and applies `count` mutations to a frame. Returns [{ kind, what }]. */
export async function mutate(client, file, frameId, { seed, count = 1, kinds = KINDS } = {}) {
  const r = rng(seed);
  const raw = await readSubtree(reader(client, file), frameId);
  const model = buildModel(raw);
  const cand = candidates(model, raw.variables);
  const done = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const avail = kinds.filter((k) => cand[k].some((c) => !used.has(c.id)));
    if (!avail.length) break;
    const kind = pick(r, avail);
    const c = pick(r, cand[kind].filter((x) => !used.has(x.id)));
    used.add(c.id);
    const op = operation(kind, c, r);
    const res = await call(client, "execute", { filePath: file, input: op.input });
    if (res.isError) throw new Error(`mutation ${kind} failed: ${text(res).slice(0, 300)}`);
    done.push({ kind, what: op.what, node: c.id });
  }
  return done;
}
