import assert from "node:assert/strict";
import { test } from "node:test";
import { addresses, buildModel, tokenValues } from "../src/design/model.js";

const raw = {
  root: "S",
  nodes: [
    { id: "S", parent: null, depth: 0, bounds: { x: 420, y: 900, width: 390, height: 844 }, type: "frame", name: "Screen", clip: true },
    { id: "H", parent: "S", depth: 1, bounds: { x: 0, y: 0, width: 390, height: 56 }, type: "frame", name: "Header" },
    { id: "T", parent: "H", depth: 2, bounds: { x: 16, y: 16, width: 100, height: 24 }, type: "text", name: "Title", fill: "$ink" },
    { id: "L", parent: "S", depth: 1, bounds: { x: 0, y: 56, width: 390, height: 900 }, type: "frame", name: "List" },
    { id: "R1", parent: "L", depth: 2, bounds: { x: 0, y: 0, width: 390, height: 60 }, type: "frame", name: "Row" },
    { id: "R2", parent: "L", depth: 2, bounds: { x: 0, y: 800, width: 390, height: 60 }, type: "frame", name: "Row" },
    { id: "I", parent: "S", depth: 1, bounds: { x: 10, y: 900, width: 50, height: 20 }, type: "frame", name: "Badge" },
    { id: "I/x", parent: "I", depth: 2, bounds: { x: 0, y: 0, width: 50, height: 20 }, type: "text", name: "Label" },
  ],
  refs: { I: ["C1", ["x"]], y: ["C2", []] },
  comps: { C1: "C/Badge", C2: "C/Icon" },
  variables: { ink: { type: "color", value: [{ value: "#111", theme: { mode: "light" } }, { value: "#eee", theme: { mode: "dark" } }] } },
  themes: { mode: ["light", "dark"] },
};

test("bounds become absolute within the screen; the screen itself sits at 0,0", () => {
  const m = buildModel(raw);
  assert.deepEqual(m.root.abs, { x: 0, y: 0, w: 390, h: 844 });
  assert.deepEqual(m.nodes.get("T").abs, { x: 16, y: 16, w: 100, h: 24 });
  assert.deepEqual(m.nodes.get("R2").abs, { x: 0, y: 856, w: 390, h: 60 });
});

test("clipping is computed from geometry against the clipping screen", () => {
  const m = buildModel(raw);
  assert.equal(m.nodes.get("L").clipped, "partially"); // 56 + 900 > 844
  assert.equal(m.nodes.get("R2").clipped, "fully"); // starts at 856
  assert.equal(m.nodes.get("I").clipped, "fully");
  assert.equal(m.nodes.get("T").clipped, undefined);
});

test("instances keep their component; content inside an instance is itself", () => {
  const m = buildModel(raw);
  assert.deepEqual(m.nodes.get("I").component, { id: "C1", name: "C/Badge", overrides: ["x"] });
  assert.equal(m.nodes.get("I/x").component, null);
});

test("token values in every theme", () => {
  assert.deepEqual(tokenValues(raw.variables, "ink"), [{ theme: "light", value: "#111" }, { theme: "dark", value: "#eee" }]);
  assert.deepEqual(tokenValues({ gap: { type: "number", value: 8 } }, "gap"), [{ theme: null, value: 8 }]);
  assert.equal(tokenValues(raw.variables, "missing"), null);
});

test("addresses are name paths; duplicates get [i] and are reported", () => {
  const { addresses: a, duplicates } = addresses(buildModel(raw));
  assert.equal(a.get("T"), "Screen/Header/Title");
  assert.equal(a.get("R1"), "Screen/List/Row[1]");
  assert.equal(a.get("R2"), "Screen/List/Row[2]");
  assert.deepEqual(duplicates, ["Screen/List/Row"]);
});

test("a nested instance swapped by an ancestor's override reports the component actually shown", () => {
  const m = buildModel({
    root: "S",
    nodes: [
      { id: "S", parent: null, bounds: { x: 0, y: 0, width: 100, height: 100 }, type: "frame", name: "S" },
      { id: "card", parent: "S", bounds: { x: 0, y: 0, width: 100, height: 50 }, type: "frame", name: "Card" },
      { id: "card/icon", parent: "card", bounds: { x: 0, y: 0, width: 10, height: 10 }, type: "frame", name: "Icon" },
    ],
    refs: { card: ["CCard", ["icon"], { icon: "CStar" }], icon: ["CDot", [], {}] },
    comps: { CCard: "C/Card", CDot: "C/Dot", CStar: "C/Star" },
  });
  assert.equal(m.nodes.get("card/icon").component.name, "C/Star");
  assert.equal(m.nodes.get("card").component.name, "C/Card");
});
