// Variants of a screen as differences from a base frame.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/design/model.js";
import { pickBase, variantDiff, variantLines } from "../src/design/variants.js";

const node = (id, parent, b, props = {}) => ({ id, parent, depth: 0, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] }, ...props });
const variables = { ink: { type: "color", value: [{ value: "#111111", theme: { mode: "light" } }, { value: "#EEEEEE", theme: { mode: "dark" } }] } };
const screen = (root, name, w, extra = [], { dark = false, layout = "vertical", titleFill = "$ink" } = {}) =>
  buildModel({
    root,
    nodes: [
      node(root, null, [0, 0, w, 800], { type: "frame", name, layout }),
      node(`${root}h`, root, [0, 0, w, 56], { type: "frame", name: "Header", width: "fill_container", height: 56 }),
      node(`${root}t`, `${root}h`, [16, 16, 100, 24], { type: "text", name: "Title", content: "Home", fontSize: 18, fill: titleFill, resolved: { fill: dark ? "#EEEEEE" : "#111111" } }),
      node(`${root}n`, root, [0, 744, w, 56], { type: "frame", name: "Nav", width: "fill_container", height: 56 }),
      ...extra,
    ],
    refs: {},
    comps: {},
    variables,
    themes: { mode: ["light", "dark"] },
  });

test("pickBase: the most common width, then no state, then the matrix order (first theme)", () => {
  const f = (id, width, state = null) => ({ id, name: id, width, row: { state } });
  assert.equal(pickBase([f("tablet", 768), f("empty", 390, "empty"), f("light", 390), f("dark", 390)]).id, "light");
});

test("a dark frame differing only through tokens is one line; a raw value is flagged", () => {
  const base = screen("L", "Home", 390);
  assert.equal(variantDiff(base, screen("D", "Home · dark", 390, [], { dark: true })).tokensOnly, true);
  const raw = screen("D", "Home · dark", 390, [], { dark: true, titleFill: "#EEEEEE" });
  const lines = variantLines({ id: "L", name: "Home", width: 390, theme: "light" }, base, [{ frame: { id: "D", name: "Home · dark", width: 390, theme: "dark" }, model: raw }], { more: (id) => `inspect(${id})` });
  assert.match(lines[1], /Home · dark \(D, 390, dark\): 0 added, 0 removed, 1 changed — ⚠ a theme variant with values not set through tokens/);
  assert.match(lines[2], /~ \/Header\/Title: color \$ink\(#111111\) → color #EEEEEE/);
});

test("a wider frame: added and removed subtrees (outermost only) and layout changes", () => {
  const base = screen("L", "Home", 390);
  const wide = screen("W", "Home · 1280", 1280, [node("Ws", "W", [0, 56, 240, 688], { type: "frame", name: "Sidebar" }), node("Wsi", "Ws", [16, 16, 200, 24], { type: "text", name: "Item", content: "Inbox" })], { layout: "horizontal" });
  wide.nodes.get("Wn").hidden = true;
  const d = variantDiff(base, wide);
  assert.deepEqual(d.added.map((x) => x.addr), ["/Sidebar"]);
  assert.deepEqual(d.removed.map((x) => x.addr), ["/Nav"]);
  const lines = variantLines({ id: "L", name: "Home", width: 390 }, base, [{ frame: { id: "W", name: "Home · 1280", width: 1280 }, model: wide }], { more: (id) => `inspect(${id})`, large: 0.9 });
  assert.match(lines.join("\n"), /\+ \/Sidebar — Sidebar \[frame\]/);
  assert.match(lines.join("\n"), /- \/Nav/);
});

test("a variant that differs in most nodes points to its own outline", () => {
  const base = screen("L", "Home", 390);
  const other = buildModel({ root: "X", nodes: [node("X", null, [0, 0, 390, 800], { type: "frame", name: "Home · empty", layout: "vertical" }), node("Xe", "X", [0, 0, 390, 200], { type: "text", name: "Empty", content: "Nothing yet" })], refs: {}, comps: {}, variables, themes: {} });
  const lines = variantLines({ id: "L", name: "Home", width: 390 }, base, [{ frame: { id: "X", name: "Home · empty", width: 390 }, model: other }], { more: (id) => `inspect(${id})` });
  assert.match(lines[1], /\d+% of its nodes differ, too many to list as differences: inspect\(X\)/);
});

test("a narrower dark frame is compared with the narrower light one; names with ' · ' and full-width boxes are not noise", () => {
  const sheet = (root, w, dark) => [node(`${root}s`, root, [0, 600, w, 200], { type: "frame", name: "Sheet · low", width: w, height: 200, fill: "$ink", resolved: { fill: dark ? "#EEEEEE" : "#111111" } })];
  const base = screen("L", "Home", 390, sheet("L", 390, false));
  const narrow = screen("N", "Home · 320", 320, sheet("N", 320, false));
  const narrowDark = screen("ND", "Home · 320 · dark", 320, sheet("ND", 320, true), { dark: true });
  const f = (id, name, width, theme) => ({ id, name, width, theme });
  const lines = variantLines(f("L", "Home", 390, "light"), base, [{ frame: f("N", "Home · 320", 320, "light"), model: narrow }, { frame: f("ND", "Home · 320 · dark", 320, "dark"), model: narrowDark }], { more: (id) => `inspect(${id})` });
  assert.match(lines[1], /Home · 320 \(N, 320, light\): same apart from positions and sizes\./);
  assert.match(lines[2], /Home · 320 · dark \(ND, 320, dark\) \(vs N\): same nodes and values; only token values differ/);
});
