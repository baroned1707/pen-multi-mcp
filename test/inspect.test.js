import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/design/model.js";
import { collapse, describe, hint, outline, sectionLines, sections, toJson } from "../src/design/inspect.js";

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

test("a first section at the top is content, not shell; a sticky CTA outside the scroll area is kept, marked fixed", () => {
  const m = buildModel({
    root: "S",
    nodes: [
      node("S", null, [0, 0, 390, 844], { type: "frame", name: "Promo", layout: "vertical" }),
      node("Hero", "S", [0, 0, 390, 120], { type: "frame", name: "Hero" }),
      node("Ht", "Hero", [16, 16, 200, 30], { type: "text", name: "T", content: "Big sale" }),
      node("Body", "S", [0, 120, 390, 604], { type: "frame", name: "Body", layout: "vertical", height: "fill_container" }),
      node("Card", "Body", [0, 0, 390, 200], { type: "frame", name: "Card" }),
      node("Cta", "S", [0, 724, 390, 64], { type: "frame", name: "Sticky CTA" }),
      node("Tabs", "S", [0, 788, 390, 56], { type: "frame", name: "Tabs" }),
    ],
    refs: {}, comps: {}, variables: {}, themes: {},
  });
  const s = sections(m);
  assert.deepEqual(s.shell.map((x) => x.node.name), ["Tabs"]);
  assert.deepEqual(s.sections.map((x) => [x.node.name, x.fixed]), [["Hero", true], ["Card", false], ["Sticky CTA", true]]);
});

test("pinned bars (absolute at an edge) are shell even without a telling name", () => {
  const m = buildModel({
    root: "S",
    nodes: [
      node("S", null, [0, 0, 390, 844], { type: "frame", name: "Map", layout: "vertical" }),
      node("M", "S", [0, 0, 390, 844], { type: "frame", name: "Canvas", height: "fill_container" }),
      node("B", "S", [0, 780, 390, 64], { type: "frame", name: "Dock", layoutPosition: "absolute" }),
    ],
    refs: {}, comps: {}, variables: {}, themes: {},
  });
  assert.deepEqual(sections(m).shell.map((x) => [x.node.name, x.where]), [["Dock", "bottom"]]);
});

test("fills as objects and arrays never render as [object Object] or a comma list", () => {
  const m = model();
  const row = m.nodes.get("R0");
  row.fill = { type: "color", color: "$ink" };
  assert.match(hint(m, row, m.nodes.get("L"), "tailwind"), /bg-\[var\(--ink\)\]/);
  assert.match(describe(m, row), /fill \$ink\(#111111 light, #EEEEEE dark\)/);
  row.fill = ["$bg", "#000000"];
  assert.match(hint(m, row, m.nodes.get("L"), "css"), /background:var\(--bg\).*\+1 more fills/);
  assert.match(describe(m, row), /fill \$bg\(#FFFFFF\) \+ 1 more fill/);
  row.fill = { type: "linear_gradient", stops: [] };
  const h = hint(m, row, m.nodes.get("L"), "tailwind");
  assert.doesNotMatch(h, /object|bg-\[/);
  assert.match(h, /gradient fill \(see design\)/);
  assert.doesNotMatch(hint(m, row, m.nodes.get("L"), "react-native"), /object Object/);
});

test("children of a group are positioned; token weights use their resolved value", () => {
  const m = buildModel({
    root: "S",
    nodes: [
      node("S", null, [0, 0, 390, 844], { type: "frame", name: "S", layout: "vertical" }),
      node("G", "S", [10, 10, 100, 100], { type: "group", name: "Badge" }),
      node("R", "G", [5, 6, 10, 10], { type: "rectangle", name: "Dot", width: 10, height: 10 }),
      node("T", "S", [0, 200, 100, 20], { type: "text", name: "T", content: "x", fontWeight: "$w", resolved: { fontWeight: "600" } }),
    ],
    refs: {}, comps: {}, variables: { w: { type: "string", value: "600" } }, themes: {},
  });
  assert.match(hint(m, m.nodes.get("R"), m.nodes.get("G"), "css"), /position:absolute; left:5px; top:6px/);
  assert.match(hint(m, m.nodes.get("T"), m.root, "css"), /font-weight:600/);
  assert.match(describe(m, m.nodes.get("T")), /\$w\(600\)/);
});

const screen = (layout, kids, extra = {}) =>
  buildModel({ root: "S", nodes: [node("S", null, [0, 0, 390, 844], { type: "frame", name: "S", layout, height: 844, ...extra }), ...kids], refs: {}, comps: {}, variables: {}, themes: {} });

test("a landing page without a filling child has no scroll container, and nothing is fixed or dropped", () => {
  const s = sections(screen("vertical", [
    node("h", "S", [0, 0, 390, 300], { type: "frame", name: "Hero" }),
    node("m", "S", [0, 300, 390, 300], { type: "frame", name: "Main features", layout: "vertical" }),
    node("m1", "m", [0, 0, 390, 100], { type: "frame", name: "Feature" }),
    node("p", "S", [0, 600, 390, 244], { type: "frame", name: "Pricing" }),
  ]));
  assert.equal(s.scroll, null);
  assert.deepEqual(s.sections.map((x) => [x.node.name, x.fixed]), [["Hero", false], ["Main features", false], ["Pricing", false]]);
});

test("a horizontal screen: the sidebar is shell on the left, Main is a section, not fixed", () => {
  const s = sections(screen("horizontal", [
    node("sb", "S", [0, 0, 240, 844], { type: "frame", name: "Sidebar", height: "fill_container" }),
    node("mn", "S", [240, 0, 150, 844], { type: "frame", name: "Main", height: "fill_container", layout: "vertical" }),
  ]));
  assert.deepEqual(s.shell.map((x) => [x.node.name, x.where]), [["Sidebar", "left"]]);
  assert.deepEqual(s.sections.map((x) => [x.node.name, x.fixed]), [["Main", false]]);
});

test("names are matched as whole words; small absolute buttons are not pinned bars", () => {
  const s = sections(screen("none", [
    node("x", "S", [340, 2, 40, 40], { type: "frame", name: "Close" }),
    node("u", "S", [0, 100, 390, 200], { type: "frame", name: "Unavailable" }),
    node("sh", "S", [0, 300, 390, 60], { type: "frame", name: "Subheader" }),
    node("pt", "S", [0, 360, 390, 60], { type: "frame", name: "Product tabs" }),
    node("lg", "S", [0, 824, 200, 20], { type: "text", name: "Legal", content: "© 2026" }),
    node("tb", "S", [0, 780, 390, 64], { type: "frame", name: "Dock" }),
    node("nt", "S", [0, 0, 100, 40], { type: "note", content: "why" }),
  ]));
  assert.deepEqual(s.shell.map((x) => [x.node.name, x.where]), [["Dock", "bottom"]]);
  assert.deepEqual(s.sections.map((x) => x.node.name ?? x.node.type), ["Close", "Unavailable", "Subheader", "Product tabs", "Legal"]);
});

test("section lists collapse repeated rows and stop at the cap", () => {
  const rowsNodes = Array.from({ length: 60 }, (_, i) => node(`r${i}`, "L", [0, i * 10, 390, 10], { type: "frame", name: "Row" }));
  const s = sections(screen("vertical", [node("L", "S", [0, 0, 390, 844], { type: "frame", name: "List", layout: "vertical", height: "fill_container" }), ...rowsNodes]));
  assert.deepEqual(sectionLines(s), ["1. Row (r0) — ", "   ×59 more like Row"]);
  const many = sections(screen("vertical", Array.from({ length: 50 }, (_, i) => node(`k${i}`, "S", [0, i * 10, 390, 10], { type: "frame", name: `Block ${i}` }))));
  const lines = sectionLines(many, { max: 5 });
  assert.equal(lines.length, 6);
  assert.match(lines[5], /45 more sections/);
});

test("a shell-like name in the middle of the page is content; at an end it is shell", () => {
  const s = sections(screen("vertical", [
    node("h", "S", [0, 0, 390, 56], { type: "frame", name: "Header" }),
    node("a", "S", [0, 56, 390, 200], { type: "frame", name: "Chân dung tác giả" }),
    node("sh", "S", [0, 256, 390, 40], { type: "frame", name: "Section header" }),
    node("l", "S", [0, 296, 390, 400], { type: "frame", name: "List" }),
    node("f", "S", [0, 780, 390, 64], { type: "frame", name: "Chân" }),
  ]));
  assert.deepEqual(s.shell.map((x) => x.node.name), ["Header", "Chân"]);
  assert.deepEqual(s.sections.map((x) => x.node.name), ["Chân dung tác giả", "Section header", "List"]);
});

test("a lone wrapper frame is unwrapped so its children are the sections", () => {
  const s = sections(screen("vertical", [
    node("sb", "S", [0, 0, 390, 44], { type: "frame", name: "Status bar" }),
    node("w", "S", [0, 44, 390, 740], { type: "frame", name: "Wrap", layout: "vertical" }),
    node("w1", "w", [0, 0, 390, 100], { type: "frame", name: "Summary" }),
    node("w2", "w", [0, 100, 390, 300], { type: "frame", name: "Holdings" }),
    node("w3", "w", [0, 400, 390, 80], { type: "frame", name: "Add position" }),
    node("tb", "S", [0, 784, 390, 60], { type: "frame", name: "Tab bar" }),
  ]));
  assert.equal(s.wrapper.name, "Wrap");
  assert.deepEqual(s.sections.map((x) => x.node.name), ["Summary", "Holdings", "Add position"]);
  const card = sections(screen("vertical", [node("c", "S", [0, 0, 390, 200], { type: "frame", name: "Card" }), node("c1", "c", [0, 0, 10, 10], { type: "text", name: "t", content: "x" })]));
  assert.deepEqual(card.sections.map((x) => x.node.name), ["Card"], "a single child is not unwrapped");
});

// Compact outline (inspect detail "normal"): one theme, defaults stated once, whole sections.
const themed = () => {
  const r = structuredClone(raw);
  for (const n of r.nodes) {
    if (n.fill === "$ink") n.resolved = { fill: "#EEEEEE", fontFamily: "Inter" };
    if (n.type === "text") n.fontFamily = "$font";
  }
  r.variables.font = { type: "string", value: "Inter" };
  return buildModel(r);
};

test("compact: values in the node's own theme only, and text defaults stated once", async () => {
  const { textDefaults } = await import("../src/design/inspect.js");
  const m = themed();
  const d = textDefaults(m, { compact: true });
  assert.equal(d.font, "$font(Inter)");
  assert.equal(d.color, "$ink(#EEEEEE)");
  const lines = outline(m, { compact: true, defaults: d });
  const title = lines.find((l) => l.includes("Title ["));
  assert.match(title, /"Today" 18 700 lh 22.5px$/, "font and color left to the defaults line");
  assert.ok(!lines.some((l) => l.includes("#111111")), "the other theme's value is not shown");
  assert.match(lines.find((l) => l.includes("Home icon")), /color \$ink\(#EEEEEE\)/);
});

test("compact: the line limit keeps whole sections and lists the rest with their calls", () => {
  const m = themed();
  const lines = outline(m, { compact: true, maxLines: 5, continueWith: (id) => `inspect(${id})` });
  assert.match(lines[1], /^ {2}Header \[/);
  assert.ok(!lines.some((l) => l.includes("Row [")), "the Content section does not fit and is not cut in the middle");
  assert.match(lines.at(-1), /section\(s\) left out to stay under 5 lines; each one: Content → inspect\(B\) · Tab bar → inspect\(T\)/);
});

test("compact: a first section larger than the limit is shown cut, like the full outline", () => {
  const m = themed();
  const lines = outline(m, { compact: true, maxLines: 2, continueWith: (id) => `inspect(${id})` });
  assert.match(lines.join("\n"), /output limit reached inside Header: inspect\(H\)/);
});
