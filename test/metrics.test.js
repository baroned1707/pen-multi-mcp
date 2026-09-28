// test/metrics.test.js
// Context metrics: what inspect gives an agent, measured (size, repetition, completeness).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/design/model.js";
import { outline, toJson } from "../src/design/inspect.js";
import { approxTokens, completeness, factsOf, redundancy } from "../src/metrics/context.js";

const node = (id, parent, b, props = {}) => ({ id, parent, depth: 0, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] }, ...props });
const raw = {
  root: "S",
  nodes: [
    node("S", null, [0, 0, 390, 844], { type: "frame", name: "Home", layout: "vertical", fill: "$bg", gap: 8 }),
    node("T", "S", [16, 16, 120, 24], { type: "text", name: "Title", content: "Today", fontSize: 18, fontWeight: "700", lineHeight: 1.25, fill: "$ink" }),
    node("C", "S", [16, 48, 358, 80], { type: "frame", name: "Card", fill: "#FAFAFA", cornerRadius: 12, padding: [16, 16] }),
    node("Ct", "C", [16, 16, 200, 20], { type: "text", name: "Body", content: "Hello there", fontSize: 14, fill: "$ink" }),
  ],
  refs: {},
  comps: {},
  variables: {
    ink: { type: "color", value: [{ value: "#111111", theme: { mode: "light" } }, { value: "#EEEEEE", theme: { mode: "dark" } }] },
    bg: { type: "color", value: "#FFFFFF" },
  },
};
export const fixtureModel = () => buildModel(structuredClone(raw));

test("outline reports the line each node is described on", () => {
  const seen = new Map();
  const lines = outline(fixtureModel(), { onNode: (id, i) => seen.set(id, i) });
  assert.deepEqual([...seen.keys()], ["S", "T", "C", "Ct"]);
  for (const [id, i] of seen) assert.match(lines[i], new RegExp(`^\\s*${{ S: "Home", T: "Title", C: "Card", Ct: "Body" }[id]} \\[`));
});


test("approxTokens counts UTF-8 bytes / 4", () => {
  assert.equal(approxTokens("abcd"), 1);
  assert.equal(approxTokens("Bản đồ"), 3); // 9 bytes
});

test("redundancy is the share of ' · ' segments already seen on an earlier line", () => {
  assert.equal(redundancy(["A · 10×10 · fill $x", "B · 20×20 · fill $x"]), 0.25);
  assert.equal(redundancy(["A · one"]), 0);
});

test("factsOf lists what an implementer needs from a node, with accepted spellings", () => {
  const nodes = toJson(fixtureModel()).nodes;
  const title = factsOf(nodes.find((n) => n.id === "T"));
  assert.deepEqual(title.map((f) => f.kind).sort(), ["color", "fontSize", "fontWeight", "size", "text"]);
  assert.ok(title.find((f) => f.kind === "color").needles.includes("$ink"));
  const card = factsOf(nodes.find((n) => n.id === "C"));
  assert.deepEqual(card.map((f) => f.kind).sort(), ["fill", "padding", "radius", "size"]);
});

test("completeness: 100% on today's outline; a dropped fact is reported with its node", () => {
  const m = fixtureModel();
  const lineOf = new Map();
  const lines = outline(m, { onNode: (id, i) => lineOf.set(id, i) });
  const nodes = toJson(m).nodes;
  const full = completeness({ lines, lineOf, nodes });
  assert.equal(full.recall, 1, JSON.stringify(full.missing));
  const cut = lines.map((l) => l.replace(/radius \S+/, ""));
  const r = completeness({ lines: cut, lineOf, nodes });
  assert.deepEqual(r.missing, [{ id: "C", kind: "radius" }]);
  // A fact given once in a defaults block counts for every node.
  const noFill = lines.map((l) => l.replace(/color \$ink\S*/, ""));
  assert.equal(completeness({ lines: noFill, lineOf, nodes, defaults: "Defaults: color $ink" }).recall, 1);
});

test("completeness stays 100% on the compact outline (with its text defaults)", async () => {
  const { textDefaults } = await import("../src/design/inspect.js");
  const r = structuredClone(raw);
  for (const n of r.nodes) if (n.fill === "$ink") n.resolved = { fill: "#EEEEEE" };
  r.nodes.push(node("T2", "S", [16, 140, 120, 20], { type: "text", name: "Sub", content: "More", fontSize: 14, fill: "$ink", resolved: { fill: "#EEEEEE" } }));
  const m = buildModel(r);
  const defaults = textDefaults(m, { compact: true });
  assert.ok(defaults?.color, "three texts share $ink");
  const lineOf = new Map();
  const lines = outline(m, { compact: true, defaults, onNode: (id, i) => lineOf.set(id, i) });
  const res = completeness({ lines, lineOf, nodes: toJson(m).nodes, defaults: defaults.line });
  assert.equal(res.recall, 1, JSON.stringify(res.missing));
});
