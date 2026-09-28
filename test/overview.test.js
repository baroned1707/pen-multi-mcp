import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, pathEnds, renderOverview } from "../src/design/overview.js";

test("arrow ends come from the first subpath (the head is a second subpath), in canvas coordinates", () => {
  const ends = pathEnds("M0 9l140 0m-10-7l10 7-10 7", [0, 0, 152, 18], { x: 384, y: 730, width: 152, height: 18 });
  assert.deepEqual(ends, { from: [384, 739], to: [524, 739] });
  const abs = pathEnds("M10 10 L110 10 L110 60", [0, 0, 200, 100], { x: 0, y: 0, width: 400, height: 200 });
  assert.deepEqual(abs, { from: [20, 20], to: [220, 120] });
});

const frame = (id, name, x, y, w, h, extra = {}) => ({ id, type: "frame", name, bounds: { x, y, width: w, height: h }, ...extra });
const data = {
  roots: [
    frame("C1", "C/Button", 0, -400, 120, 44, { reusable: true }),
    { id: "t1", type: "text", content: "FLOW 1 · BUYER", bounds: { x: -700, y: -60, width: 400, height: 75 } },
    { id: "t2", type: "text", content: "Home row", bounds: { x: -700, y: 100, width: 200, height: 30 } },
    frame("A", "Home · light", 0, 0, 390, 844, { theme: { mode: "light" } }),
    frame("B", "Checkout · light", 560, 0, 390, 844, { theme: { mode: "light" } }),
    frame("Ad", "Home · dark", 0, 944, 390, 844, { theme: { mode: "dark" } }),
    { id: "p1", type: "path", geometry: "M0 9l140 0m-10-7l10 7-10 7", viewBox: [0, 0, 152, 18], bounds: { x: 400, y: 400, width: 152, height: 18 } },
    frame("lab", "→ pay", 420, 360, 100, 39),
    frame("Z", "Settings · light", 0, 5000, 390, 844),
    { id: "n1", type: "note", content: "Checkout must fit one screen", bounds: { x: 0, y: -200, width: 300, height: 60 } },
  ],
  variables: { gap: { type: "number", value: 8 } },
  themes: { mode: ["light", "dark"] },
};
const stats = {
  A: { refs: { C1: 2 }, fontSizes: [16, 16, 16, 13], spacing: ["$gap", 16, 16], rawFills: { "#FFFFFF": 1 }, tokenFills: 5, notes: [] },
  B: { refs: { C1: 1 }, fontSizes: [16, 27], spacing: [8], rawFills: {}, tokenFills: 3, notes: [] },
};

test("analysis: matrix, bands with their title, flows with labels, component usage, scales, notes", () => {
  const a = analyze(data, stats);
  assert.equal(a.counts.screens, 4);
  const home = a.matrix.rows.find((r) => r.screen === "Home");
  assert.deepEqual(home.cells[390].map((c) => c.theme), ["light", "dark"]);
  assert.equal(a.bands.length, 2);
  assert.equal(a.bands[0].label, "FLOW 1 · BUYER", "the tallest label near the top, not the row label");
  assert.deepEqual(a.flows, [{ from: "Home · light", to: "Checkout · light", label: "pay", confidence: "high" }]);
  assert.deepEqual(a.components[0], { id: "C1", name: "C/Button", instances: 3, screens: ["Home · light", "Checkout · light"] });
  assert.deepEqual(a.spacing.used.find(([v]) => v === 8), [8, 2], "tokens resolve to their value");
  assert.deepEqual(a.typeScale.offScale, [13, 27]);
  assert.ok(a.notes.includes("Checkout must fit one screen"));
});

test("declared flows are added; focus narrows rows and flows", () => {
  const a = analyze(data, stats, { flowEdges: [{ from: "Checkout · light", to: "Settings · light", ev: "done" }] });
  assert.equal(a.flows.at(-1).confidence, "declared");
  const text = renderOverview(a, { file: "x.pen", focus: "Checkout" }).join("\n");
  assert.match(text, /Checkout \|  \| light/);
  assert.doesNotMatch(text, /^Home \|/m);
  assert.match(text, /Checkout · light → id B/);
  assert.match(text, /Home · light → Checkout · light "pay"/);
});

test("output is capped", () => {
  const lines = renderOverview(analyze(data, stats), { file: "x.pen", maxLines: 5 });
  assert.equal(lines.length, 6);
  assert.match(lines[5], /output cut at 5 lines/);
});

test("stateHint: screens that extend another screen's name, and cells with two frames of one theme", async () => {
  const { stateHint } = await import("../src/design/overview.js");
  const row = (screen, cells = { 390: [{ theme: "light" }] }, state = null) => ({ screen, state, cells });
  assert.equal(stateHint([row("Home"), row("Settings")]), null);
  const h = stateHint([row("S1 · Map"), row("S1 · Map · two pins"), row("S2", { 390: [{ theme: "light" }, { theme: "light" }] })]);
  assert.match(h, /1 screen\(s\) look like states of another screen \("S1 · Map · two pins"\); 1 row\(s\) hold two frames of the same width and theme \("S2"\)\. Name a state after an em dash/);
});
