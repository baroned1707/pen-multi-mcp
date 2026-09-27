import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/design/model.js";
import { collapse, describe, hint, outline, sections, toJson } from "../src/design/inspect.js";

const node = (id, parent, bounds, props = {}) => ({ id, parent, depth: 0, bounds: { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] }, ...props });
const rows = ["Alpha", "Beta", "Gamma", "Delta"].flatMap((t, i) => [
  node(`R${i}`, "L", [0, i * 60, 390, 60], { type: "frame", name: "Row", layout: "horizontal", padding: [0, 16], width: "fill_container" }),
  node(`R${i}t`, `R${i}`, [16, 18, 200, 24], { type: "text", name: "Label", content: t, fontSize: 16, lineHeight: 1.5, fill: "$ink", width: "fill_container", textGrowth: "fixed-width" }),
]);
const raw = {
  root: "S",
  nodes: [
    node("S", null, [900, 0, 390, 844], { type: "frame", name: "Home", layout: "vertical", clip: true, fill: "$bg" }),
    node("H", "S", [0, 0, 390, 56], { type: "frame", name: "Header", stroke: "$line", strokeWidth: { bottom: 1 }, width: "fill_container", height: 56 }),
    node("Ht", "H", [16, 16, 100, 24], { type: "text", name: "Title", content: "Today", fontSize: 18, fontWeight: "700", lineHeight: 1.25, fill: "$ink" }),
    node("B", "S", [0, 56, 390, 732], { type: "frame", name: "Content", layout: "vertical", height: "fill_container", width: "fill_container", gap: 12 }),
    node("L", "B", [0, 0, 390, 240], { type: "frame", name: "List", layout: "vertical" }),
    ...rows,
    node("X", "B", [0, 252, 390, 40], { type: "frame", name: "Secret", enabled: false }),
    node("T", "S", [0, 788, 390, 56], { type: "frame", name: "Tab bar" }),
    node("Ti", "T", [20, 16, 24, 24], { type: "icon", name: "Home icon", library: "lucide", icon: "house", fill: "$ink" }),
  ],
  refs: {},
  comps: {},
  variables: {
    ink: { type: "color", value: [{ value: "#111111", theme: { mode: "light" } }, { value: "#EEEEEE", theme: { mode: "dark" } }] },
    bg: { type: "color", value: "#FFFFFF" },
    line: { type: "color", value: "#DDDDDD" },
  },
};
const model = () => buildModel(structuredClone(raw));

test("a line shows size, position, sizing, layout and tokens with every theme's value", () => {
  const m = model();
  assert.match(describe(m, m.nodes.get("Ht")), /Title \[text\] · 100×24 @16,16 · "Today" 18 700 lh 22.5px · color \$ink\(#111111 light, #EEEEEE dark\)/);
  assert.match(describe(m, m.nodes.get("H")), /stroke \$line\(#DDDDDD\) bottom 1/);
});

test("repeated siblings collapse, with the content that differs", () => {
  const m = model();
  const groups = collapse(m.nodes.get("L").children);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 4);
  const text = outline(m).join("\n");
  assert.match(text, /×3 more like Row \(content: "Beta", "Gamma", "Delta"\)/);
  assert.doesNotMatch(text, /Secret/);
  assert.match(text, /\(1 hidden\)/);
});

test("sections come from the scroll container; docked header and tab bar are shell", () => {
  const s = sections(model());
  assert.equal(s.scroll.name, "Content");
  assert.deepEqual(s.shell.map((x) => [x.node.name, x.where]), [["Header", "top"], ["Tab bar", "bottom"]]);
  assert.deepEqual(s.sections.map((x) => x.node.name), ["List"]);
  assert.deepEqual(s.sections[0].items, ['"Alpha"', '"Beta"', '"Gamma"', '"Delta"']);
});

test("code hints follow the parent's direction and the project's flavor", () => {
  const m = model();
  const row = m.nodes.get("R0"), label = m.nodes.get("R0t"), list = m.nodes.get("L"), header = m.nodes.get("H");
  assert.match(hint(m, label, row, "tailwind"), /flex-1/); // fill inside a row
  assert.match(hint(m, row, list, "tailwind"), /w-full/); // fill inside a column
  assert.match(hint(m, row, list, "tailwind"), /py-\[0px\] px-\[16px\]/);
  assert.match(hint(m, header, m.root, "tailwind"), /border-b-\[1px\] border-\[var\(--line\)\]/);
  assert.match(hint(m, label, row, "react-native"), /lineHeight:24.*color:T\.ink.*includeFontPadding:false/);
  assert.match(hint(m, header, m.root, "react-native"), /borderBottomWidth:1/);
  assert.match(hint(m, label, row, "css"), /flex:1.*line-height:24px.*color:var\(--ink\)/);
});

test("output is cut at maxLines with the call that continues", () => {
  const lines = outline(model(), { maxLines: 3, continueWith: (id) => `inspect target "${id}"` });
  assert.equal(lines.length, 4);
  assert.match(lines[3], /output limit reached at Home\/.*: inspect target "/);
});

test("output is cut at depth with the call that continues", () => {
  const text = outline(model(), { depth: 1, continueWith: (id) => `inspect target "${id}"` }).join("\n");
  assert.match(text, /… 10 nodes below: inspect target "B"/);
  assert.match(text, /… 1 node below: inspect target "H"/);
});

test("json form carries addresses, absolute bounds and components", () => {
  const j = toJson(model());
  const t = j.nodes.find((n) => n.id === "R1t");
  assert.equal(t.address, "Home/Content/List/Row[2]/Label");
  assert.deepEqual(t.bounds, { x: 16, y: 134, w: 200, h: 24 });
  assert.deepEqual(j.duplicateNames, ["Home/Content/List/Row"]);
});
