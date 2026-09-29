// Code → design layout edits inferred from where the UI draws the matched children.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/design/model.js";
import { layoutEdits } from "../src/verify/layout.js";

const node = (id, parent, b, props = {}) => ({ id, parent, depth: 0, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] }, ...props });
// A screen with a vertical list (gap 8, padding 16) of three 40px rows, and an absolute badge.
const model = () =>
  buildModel({
    root: "S",
    nodes: [
      node("S", null, [0, 0, 390, 844], { type: "frame", name: "S", layout: "none" }),
      node("L", "S", [0, 0, 390, 200], { type: "frame", name: "List", layout: "vertical", gap: 8, padding: 16, fill: "#FFF" }),
      node("A", "L", [16, 16, 358, 40], { type: "frame", name: "A", width: 358, height: 40, fill: "#EEE" }),
      node("B", "L", [16, 64, 358, 40], { type: "frame", name: "B", width: 358, height: 40, fill: "#EEE" }),
      node("C", "L", [16, 112, 358, 40], { type: "frame", name: "C", width: 358, height: 40, fill: "#EEE" }),
      node("X", "S", [300, 500, 40, 20], { type: "frame", name: "Badge", width: 40, height: 20, fill: "#F00" }),
    ],
    refs: {},
    comps: {},
    variables: {},
  });
const pairs = (boxes) => new Map(Object.entries(boxes).map(([id, [x, y, w, h]]) => [id, { box: { x, y, w, h } }]));
const base = { L: [0, 0, 390, 200], A: [16, 16, 358, 40], B: [16, 64, 358, 40], C: [16, 112, 358, 40], X: [300, 500, 40, 20] };

test("nothing to change when the UI draws the design", () => {
  assert.deepEqual(layoutEdits(model(), pairs(base)).edits, []);
});

test("an even gap the UI uses; a token when one is used for spacing", () => {
  const ui = pairs({ ...base, B: [16, 72, 358, 40], C: [16, 128, 358, 40] });
  const { edits } = layoutEdits(model(), ui, { spacing: new Map([[16, "$s16"]]) });
  assert.deepEqual(edits.map((e) => e.op), ['Update("L", { gap: "$s16" })']);
  assert.ok(edits[0].explains.has("C"), "explains the moved rows");
});

test("uneven spacing gives a reason, not an edit", () => {
  const { edits, notes } = layoutEdits(model(), pairs({ ...base, B: [16, 72, 358, 40], C: [16, 114, 358, 40] }));
  assert.equal(edits.length, 0);
  assert.match(notes[0], /List: its children are unevenly spaced in the UI \(16, 2 px\)/);
});

test("leading padding, order, fixed size and absolute position", () => {
  const padded = layoutEdits(model(), pairs({ L: [0, 0, 390, 220], A: [24, 24, 358, 40], B: [24, 72, 358, 40], C: [24, 120, 358, 40], X: base.X }));
  assert.deepEqual(padded.edits.map((e) => e.op), ['Update("L", { padding: [24, 16, 16, 24] })']);
  const moved = layoutEdits(model(), pairs({ ...base, A: [16, 64, 358, 40], B: [16, 16, 358, 40] }));
  assert.deepEqual(moved.edits.map((e) => e.op), ['Move("B", "L", 0); Move("A", "L", 1); Move("C", "L", 2)']);
  const sized = layoutEdits(model(), pairs({ ...base, C: [16, 112, 358, 56] }));
  assert.deepEqual(sized.edits.map((e) => e.op), ['Update("C", { height: 56 })']);
  const abs = layoutEdits(model(), pairs({ ...base, X: [320, 480, 40, 20] }));
  assert.deepEqual(abs.edits.map((e) => e.op), ['Update("X", { x: 320, y: 480 })']);
});
