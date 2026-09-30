// Responsive widths and interaction states: verify between the design's widths, the whole
// width × theme matrix at once, one element against a component state frame, and lint for the
// states the design does not draw.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { splitSteps } from "../src/verify/adapters/web.js";
import { cropSnapshot, stateStep } from "../src/verify/element.js";
import { elementFindings } from "../src/verify/pipeline.js";
import { betweenFindings, betweenWidths, nearestWidth } from "../src/verify/responsive.js";
import { componentState, hasRepeated, lintStates } from "../src/lint/rules.js";
import { call, connect, text } from "./helpers.js";

test("interaction steps and the steps after them run last; the others first", () => {
  assert.deepEqual(splitSteps([{ click: "a" }, { wait: 5 }]), { early: [{ click: "a" }, { wait: 5 }], late: [] });
  assert.deepEqual(splitSteps([{ click: "a" }, { hover: "b" }, { wait: 5 }]), { early: [{ click: "a" }], late: [{ hover: "b" }, { wait: 5 }] });
  assert.deepEqual(splitSteps([{ focus: "i" }]), { early: [], late: [{ focus: "i" }] });
});

test("a state frame's name gives the step that shows it", () => {
  assert.equal(stateStep("Button — hover"), "hover");
  assert.equal(stateStep("Button / Hover"), "hover");
  assert.equal(stateStep("Button · focus"), "focus");
  assert.equal(stateStep("Button/State=Pressed"), "down");
  assert.equal(stateStep("Primary - active"), "down");
  assert.equal(stateStep("Hover card"), null);
  assert.equal(stateStep("Button — disabled"), null);
  assert.equal(stateStep("Button"), null);
});

test("widths between the design's, and the nearest design width", () => {
  assert.deepEqual(betweenWidths([834, 390, 1440, 390]), [{ width: 612, below: 390, above: 834 }, { width: 1137, below: 834, above: 1440 }]);
  assert.deepEqual(betweenWidths([390]), []);
  assert.equal(nearestWidth([390, 834], 612), 390); // a tie goes to the narrower
  assert.equal(nearestWidth([390, 834], 700), 834);
});

const el = (i, text, box, extra = {}) => ({ i, text, box, textBox: box, ...extra });

test("between checks: sideways scrolling, cut text, overlapping text, small targets, texts gone", () => {
  const snapshot = {
    viewport: { w: 612, h: 900 },
    responsive: {
      viewportW: 612,
      scrollW: 760,
      overflow: [{ selector: "div.wide", text: "Wide row", box: { x: 0, y: 0, w: 760, h: 20 }, right: 760 }],
      cut: [{ selector: "p.cut", text: "Recent orders list", box: { x: 0, y: 40, w: 40, h: 20 }, how: "hidden" }, { selector: "p.e", box: { x: 0, y: 80, w: 40, h: 20 }, how: "ellipsis" }],
      targets: [{ selector: "a.x", box: { x: 0, y: 0, w: 16, h: 16 } }, { selector: "button", box: { x: 0, y: 0, w: 44, h: 44 } }],
    },
    elements: [el(0, "Welcome", { x: 0, y: 0, w: 100, h: 20 }), el(1, "Price", { x: 10, y: 200, w: 80, h: 20 }), el(2, "Total", { x: 20, y: 204, w: 80, h: 20 }), el(3, "Badge", { x: 20, y: 204, w: 60, h: 20 }, { absolute: true })],
  };
  const found = betweenFindings(snapshot, { nearest: { name: "Home · 390", width: 390, texts: ["Welcome", "Recent orders"] } });
  const kinds = found.map((f) => `${f.severity}:${f.kind}`);
  assert.deepEqual(kinds, ["high:overflow", "high:overlap", "medium:cut", "medium:structure", "low:cut", "low:target"], found.map((f) => f.message).join("\n"));
  assert.match(found[0].message, /760 wide in a 612 viewport.*div\.wide "Wide row" to x 760/);
  assert.match(found.find((f) => f.kind === "structure").message, /"Recent orders"/);
  // Wide viewports: targets are not checked; a page that fits has no overflow.
  const wide = betweenFindings({ ...snapshot, viewport: { w: 1200 }, responsive: { ...snapshot.responsive, viewportW: 1200, scrollW: 1200 } }, {});
  assert.ok(!wide.some((f) => f.kind === "overflow" || f.kind === "target"));
});

test("a capture cut to one element: its contents at its origin, its background as the page's", () => {
  const snap = {
    viewport: { w: 1280, h: 900 },
    pageBg: "rgba(255, 255, 255, 1)",
    element: { box: { x: 40, y: 40, w: 160, h: 44 }, bg: "rgba(29, 78, 216, 1)", radius: 8, selector: "[data-pen=\"Button\"]" },
    elements: [
      { i: 0, box: { x: 0, y: 0, w: 1280, h: 900 } },
      { i: 1, parent: 0, box: { x: 40, y: 40, w: 160, h: 44 }, bg: "rgba(29, 78, 216, 1)" },
      { i: 2, parent: 1, text: "Pay now", box: { x: 80, y: 52, w: 80, h: 20 }, textBox: { x: 82, y: 52, w: 76, h: 20 } },
      { i: 3, text: "Elsewhere", box: { x: 400, y: 400, w: 80, h: 20 } },
    ],
  };
  const c = cropSnapshot(snap);
  assert.deepEqual(c.viewport, { w: 160, h: 44 });
  assert.equal(c.pageBg, "rgba(29, 78, 216, 1)");
  assert.deepEqual(c.elements.map((e) => [e.i, e.parent, e.box.x, e.box.y, e.textBox?.x]), [[2, undefined, 40, 12, 42]]);
  assert.equal(c.page.pageBg, "rgba(255, 255, 255, 1)");
});

test("a component's own fill and radius are compared with the element's", () => {
  const design = { frame: { id: "h1", name: "Button — hover", w: 160, h: 44, fill: "#1D4ED8", radius: 8 } };
  const same = { element: { bg: "rgba(29, 78, 216, 1)", radius: 8, box: { w: 160, h: 44 }, selector: "b" }, page: { pageBg: "#fff" } };
  assert.deepEqual(elementFindings(design, same), []);
  const off = { element: { bg: "rgba(37, 99, 235, 1)", radius: 22, box: { w: 160, h: 44 }, selector: "b" }, page: { pageBg: "#fff" } };
  const f = elementFindings(design, off);
  assert.deepEqual(f.map((x) => `${x.severity}:${x.kind}`), ["high:fill", "medium:radius"]);
  assert.match(f[0].message, /#2563EB on the element \(b\), #1D4ED8 in the design/);
  // Pills: 999 and a height-bound radius are the same shape.
  assert.deepEqual(elementFindings({ frame: { ...design.frame, radius: 999 } }, { ...same, element: { ...same.element, radius: 22 } }), []);
});

test("lint states: interactive components without their states, list screens without empty/error/loading", () => {
  assert.deepEqual(componentState("Button/State=Hover"), { base: "button", state: "hover" });
  assert.deepEqual(componentState("Button — primary — pressed"), { base: "button / primary", state: "pressed" });
  assert.deepEqual(componentState("Tab bar"), { base: "tab bar", state: null });
  const analysis = {
    components: [
      { id: "b", name: "Button" },
      { id: "bh", name: "Button — hover" },
      { id: "i", name: "Text field" },
      { id: "t", name: "Tab bar" },
      { id: "c", name: "Card" },
    ],
    matrix: {
      rows: [
        { screen: "Orders", state: null, cells: { 390: [{ id: "o1" }], 1280: [{ id: "o2" }] } },
        { screen: "Orders", state: "empty", cells: { 390: [{ id: "o3" }] } },
        { screen: "Profile", state: null, cells: { 390: [{ id: "p1" }] } },
      ],
    },
  };
  const found = lintStates(analysis, { repeated: new Map([["o1", true], ["p1", false]]) });
  const lines = found.map((f) => `${f.address}: ${f.message}`);
  assert.equal(found.length, 3, lines.join("\n"));
  assert.match(lines[0], /^Button: .*without its focus, disabled states \(has hover\)/);
  assert.match(lines[1], /^Text field: .*focus, disabled, error/);
  // Nobody draws error or loading: one decision for the document, not one finding per screen.
  assert.match(lines[2], /^document: no screen draws the error or loading state, and 1 screen shows repeated content \(Orders\)/);
  // A list without the empty state another list has: that screen.
  const gap = lintStates(analysis, { repeated: new Map([["o1", true], ["p1", true]]) }).filter((f) => f.address === "Profile");
  assert.match(gap[0]?.message ?? "", /has no empty frame .*which other screens have/);
  // Phone-only documents expect pressed instead of hover and focus.
  const phone = lintStates({ ...analysis, matrix: { rows: [analysis.matrix.rows[2]] } });
  assert.match(phone.find((f) => f.address === "Button").message, /pressed, disabled/);
});

test("repeated content is rows of one kind; items side by side (a tab bar) are not", () => {
  const node = (id, y, kids = [], extra = {}) => ({ id, type: "frame", abs: { x: 0, y, w: 10, h: 10 }, children: kids, ...extra });
  const t = (id) => ({ id, type: "text", children: [], abs: { x: 0, y: 0 } });
  const list = node("l", 0, [0, 60, 120].map((y, k) => node(`r${k}`, y, [t(`a${k}`), t(`b${k}`)])));
  const bar = node("bar", 0, [0, 0, 0].map((y, k) => node(`i${k}`, y, [t(`x${k}`), t(`y${k}`)])));
  const model = (root) => {
    const nodes = new Map();
    const walk = (n) => (nodes.set(n.id, n), n.children.forEach(walk));
    walk(root);
    return { nodes };
  };
  assert.equal(hasRepeated(model(list)), true);
  assert.equal(hasRepeated(model(bar)), false);
});

// End to end: the real engine and headless Chromium.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-states-")));
const file = path.join(dir, "app.pen");
let client;
const url = (name) => `file://${path.join(dir, name)}`;
const exec = async (input) => {
  const res = await call(client, "execute", { filePath: file, input });
  assert.ok(!res.isError, text(res));
};

before(async () => {
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" } });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await exec(`for (const [name, x, fill] of [["Button", 0, "#2563EB"], ["Button — hover", 200, "#1D4ED8"]]) {
    const b = Insert(document, { type: "frame", name, reusable: true, x, y: -400, width: 160, height: 44, layout: "horizontal", justifyContent: "center", alignItems: "center", fill, cornerRadius: 8 });
    Insert(b, { type: "text", name: "Label", content: "Pay now", fill: "#FFFFFF", fontFamily: "Inter", fontSize: 16, fontWeight: "600" });
  }
  for (const [w, x] of [[390, 0], [834, 500]]) {
    const s = Insert(document, { type: "frame", name: "Home · " + w, x, y: 0, width: w, height: 600, layout: "vertical", gap: 8, padding: 16, fill: "#FFFFFF" });
    Insert(s, { type: "text", name: "Title", content: "Welcome", fill: "#111111", fontFamily: "Inter", fontSize: 24 });
    Insert(s, { type: "text", name: "Recent", content: "Recent orders", fill: "#111111", fontFamily: "Inter", fontSize: 16 });
    Insert(s, { type: "text", name: "Note", content: "Footer note", fill: "#111111", fontFamily: "Inter", fontSize: 12 }); // never on the page
    const list = Insert(s, { type: "frame", name: "List", width: "fill_container", layout: "vertical", gap: 8 });
    for (const t of ["A", "B", "C"]) { const r = Insert(list, { type: "frame", name: "Row", width: "fill_container", height: 40 }); Insert(r, { type: "text", content: t, fill: "#111111" }); Insert(r, { type: "text", content: t + "1", fill: "#111111" }); }
  }`);
  const button = (hover) => `<!doctype html><style>body{margin:0;font-family:Inter,sans-serif}.b{width:160px;height:44px;display:flex;align-items:center;justify-content:center;background:#2563EB;border-radius:8px;color:#fff;font:600 16px Inter,sans-serif;border:0;margin:40px;padding:0}${hover ? ".b:hover{background:#1D4ED8}" : ""}</style><button class="b" data-pen="Button"><span>Pay now</span></button>`;
  fs.writeFileSync(path.join(dir, "button.html"), button(true));
  fs.writeFileSync(path.join(dir, "button-nohover.html"), button(false));
  fs.writeFileSync(
    path.join(dir, "home.html"),
    `<!doctype html><style>body{margin:0;padding:16px;font:16px Inter,sans-serif}@media (min-width:500px) and (max-width:800px){.wide{width:760px}.cut{width:40px;overflow:hidden;white-space:nowrap}.gone{display:none}}</style>
    <h1 style="font-size:24px;margin:0">Welcome</h1><div class="wide">Wide row</div><p class="cut">Order history list</p><p class="gone">Recent orders</p>`,
  );
});

after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const verify = (args) => call(client, "verify", { filePath: file, ...args });

test("one element against a component state frame: hover is applied for the state, and a missing hover is found", async () => {
  const hover = await verify({ target: "Button — hover", source: { kind: "web", url: url("button.html"), element: '[data-pen="Button"]' }, crops: 0 });
  assert.ok(!hover.isError, text(hover));
  assert.match(text(hover), /Verdict: MATCH/, text(hover)); // the screenshot shows the hover too
  const none = await verify({ target: "Button — hover", source: { kind: "web", url: url("button-nohover.html"), element: '[data-pen="Button"]' }, crops: 0 });
  assert.match(text(none), /fill: #2563EB on the element \(\[data-pen="Button"\]\), #1D4ED8 in the design/, text(none));
  const rest = await verify({ target: "Button", source: { kind: "web", url: url("button.html"), element: '[data-pen="Button"]' }, crops: 0 });
  assert.ok(!/fill: .* on the element/.test(text(rest)), text(rest));
  const missing = await verify({ target: "Button", source: { kind: "web", url: url("button.html"), element: ".nope" } });
  assert.ok(missing.isError && /matches nothing/.test(text(missing)), text(missing));
});

test("between the design widths: sideways scrolling, cut text and a text of the nearest design gone are found", async () => {
  const res = await verify({ target: "Home · 390", source: { kind: "web", url: url("home.html") }, between: true, crops: 0 });
  assert.ok(!res.isError, text(res));
  const t = text(res);
  const part = t.split("## Between the design widths")[1] ?? "";
  assert.match(part, /### 612 \(between 390 and 834; nearest design Home · 390\) — PROBLEMS/, t);
  assert.match(part, /\[high\] overflow: the page scrolls sideways: \d+ wide in a 612 viewport. Past the right edge: div.wide "Wide row" to x \d+/);
  assert.match(part, /\[medium\] cut: text cut off: p\.cut "Order history list"/);
  assert.match(part, /\[medium\] structure: 1 text\(s\) of Home · 390 that the page shows at 390 are gone at this width: "Recent orders"/);
  assert.ok(!/Footer note/.test(part), part); // missing at the design width too: a port finding, not a breakpoint
  assert.match(t.trim().split("\n").at(-1), /^Next/); // Next stays last
});

test("matrix: every frame of the screen in one call, as a table", async () => {
  const res = await verify({ target: "Home · 390", source: { kind: "web", url: url("home.html") }, matrix: true });
  assert.ok(!res.isError, text(res));
  const t = text(res);
  assert.match(t, /# verify matrix: Home \(2 frames\)/, t.slice(0, 800));
  assert.match(t, /\| Home · 390 \(\S+\) \| 390 \|/);
  assert.match(t, /\| Home · 834 \(\S+\) \| 834 \|/);
  assert.match(t, /of 2 frames MATCH/);
});

test("lint states on a document: the button without focus and disabled, the list screen without empty/error/loading", async () => {
  const res = await call(client, "lint", { filePath: file, rules: ["states"] });
  assert.ok(!res.isError, text(res));
  const t = text(res);
  assert.match(t, /states · Button · Button \(\S+\): interactive component without its focus, disabled states \(has hover\)/, t);
  assert.match(t, /states · document · document \(\S+\): no screen draws the empty, error or loading state, and 1 screen shows repeated content \(Home\)/, t);
});
