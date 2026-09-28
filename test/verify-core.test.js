// verify's comparison core without an engine or browser: colors, images, matching, findings,
// pixel regions, and the native / probe parsers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { colorString, hostViews, publicInstance, snapshotElements } from "../probe/react-native/collect.js";
import { parseMaestro, parseUiautomator, withSampledColors } from "../src/verify/adapters/native.js";
import { deltaE, parseColor, toHex } from "../src/verify/color.js";
import { compare, effectiveBg, summarize } from "../src/verify/compare.js";
import { blank, label, resize, sampleColors, strokeRect } from "../src/verify/image.js";
import { markerValue, match } from "../src/verify/match.js";
import { verifyScreen } from "../src/verify/pipeline.js";
import { nodesAt, pixelRegions } from "../src/verify/visual.js";

test("colors: hex, rgb(a) in both syntaxes, transparent; ΔE separates near from far", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#11223380"), { r: 17, g: 34, b: 51, a: 128 / 255 });
  assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor("rgb(1 2 3 / 50%)"), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.equal(parseColor("transparent").a, 0);
  assert.equal(parseColor("linear-gradient(red, blue)"), null);
  assert.equal(toHex(parseColor("rgba(17,17,17,1)")), "#111111");
  assert.ok(deltaE(parseColor("#111111"), parseColor("#131313")) < 2);
  assert.ok(deltaE(parseColor("#111111"), parseColor("#DC2626")) > 50);
});

test("images: area-average resize, dominant color sampling, boxes and digits stay in bounds", () => {
  const img = blank(20, 10, [255, 0, 0]);
  for (let y = 0; y < 10; y++) for (let x = 10; x < 20; x++) img.data.set([0, 0, 255, 255], (y * 20 + x) * 4);
  const half = resize(img, 10);
  assert.equal(half.width, 10);
  assert.equal(half.height, 5);
  assert.deepEqual([...half.data.slice(0, 3)], [255, 0, 0]);
  const { bg, fg } = sampleColors(img, { x: 0, y: 0, w: 14, h: 10 });
  assert.deepEqual([bg.r, bg.b], [255, 0]);
  assert.deepEqual([fg.r, fg.b], [0, 255]);
  strokeRect(img, { x: -5, y: -5, w: 40, h: 40 }, [0, 0, 0]);
  label(img, 18, 8, 42, [0, 0, 0]);
});

// A small design: a screen with a header (title), a list section of three rows, and a button.
const node = (id, kind, box, extra = {}) => ({ id, kind, name: extra.name ?? id, address: `S/${extra.path ?? id}`, box, ancestors: extra.ancestors ?? [], ...extra });
const design = () => {
  const nodes = [
    node("hdr", "shell", { x: 0, y: 0, w: 390, h: 56 }, { name: "Header", path: "Header", fill: parseColor("#F3F4F6") }),
    node("title", "text", { x: 16, y: 18, w: 90, h: 20 }, { name: "Title", path: "Header/Title", text: "Checkout", color: parseColor("#111111"), fontSize: 20, fontWeight: 700, ancestors: ["hdr"] }),
    node("list", "section", { x: 0, y: 72, w: 390, h: 144 }, { name: "List", path: "List" }),
    ...["Alpha", "Beta", "Gamma"].map((t, k) => node(`row${k}`, "text", { x: 16, y: 86 + k * 48, w: 60, h: 20 }, { name: "Label", path: `List/Row[${k + 1}]/Label`, text: t, color: parseColor("#111111"), fontSize: 16, fontWeight: 400, ancestors: ["list"] })),
    node("pay", "section", { x: 16, y: 232, w: 358, h: 48 }, { name: "Pay", path: "Pay", component: "C/Button", fill: parseColor("#2563EB"), radius: 10 }),
    node("payl", "text", { x: 160, y: 246, w: 70, h: 20 }, { name: "Label", path: "Pay/Label", text: "Pay now", color: parseColor("#FFFFFF"), fontSize: 16, fontWeight: 600, ancestors: ["pay"], insideInstance: true }),
  ];
  const addresses = new Map(nodes.map((n) => [n.id, n.address]));
  return { nodes, frame: { id: "S", name: "S", w: 390, h: 844 }, order: ["list", "pay"], allNames: new Set(nodes.map((n) => n.name)), nodeIds: new Set(addresses.keys()), addresses };
};
// The UI that implements it exactly (as a DOM snapshot would describe it).
const faithfulUi = () => {
  const els = [];
  const add = (o) => els.push({ i: els.length, ...o });
  add({ tag: "header", box: { x: 0, y: 0, w: 390, h: 56 }, bg: "rgb(243, 244, 246)" });
  add({ parent: 0, tag: "h1", text: "Checkout", box: { x: 16, y: 18, w: 95, h: 24 }, fg: "rgb(17,17,17)", fontSize: 20, fontWeight: 700 });
  add({ tag: "ul", box: { x: 0, y: 72, w: 390, h: 144 } });
  ["Alpha", "Beta", "Gamma"].forEach((t, k) => add({ parent: 2, tag: "li", text: t, box: { x: 16, y: 86 + k * 48, w: 55, h: 19 }, fg: "#111", fontSize: 16, fontWeight: 400 }));
  add({ tag: "button", box: { x: 16, y: 232, w: 358, h: 48 }, bg: "#2563EB", radius: 10 });
  add({ parent: 6, tag: "span", text: "Pay now", box: { x: 161, y: 246, w: 68, h: 19 }, fg: "#fff", fontSize: 16, fontWeight: 600 });
  return { elements: els };
};
const FIELDS = ["text", "bg", "fg", "fontSize", "fontWeight", "lineHeight", "radius", "border"];
const run = (d, ui) => {
  const m = match(d, ui);
  const findings = compare(d, ui, m, { fields: FIELDS });
  return { m, findings, summary: summarize(d, m, findings) };
};

test("a faithful UI matches: texts by text, sections by the elements enclosing their texts", () => {
  const { m, findings, summary } = run(design(), faithfulUi());
  assert.deepEqual(findings, []);
  assert.equal(summary.verdict, "match");
  assert.equal(summary.matched, 8);
  assert.equal(m.pairs.get("list").el.tag, "ul");
  assert.equal(m.pairs.get("pay").el.tag, "button");
  assert.equal(summary.score, 100);
});

test("markers win over text, repeated markers pair in reading order, unknown markers are reported", () => {
  const ui = faithfulUi();
  ui.elements[3].marker = "List/Row/Label";
  ui.elements[4].marker = "List/Row/Label";
  ui.elements[5].marker = "List/Row/Label";
  ui.elements[1].marker = "pen:Header/Titel";
  const { m, findings } = run(design(), ui);
  assert.equal(m.pairs.get("row0").how, "marker");
  assert.equal(m.pairs.get("row2").el.text, "Gamma");
  assert.ok(findings.some((f) => f.kind === "marker" && /Header\/Titel/.test(f.message)));
  assert.equal(markerValue("com.app:id/pen:Header"), "Header");
  assert.equal(markerValue("Header"), "Header");
});

test("drift: missing shell folded with its texts, extra text, section order, color, size and type", () => {
  const d = design();
  const ui = faithfulUi();
  ui.elements.splice(0, 2); // header and its title are gone
  ui.elements.forEach((el) => {
    if (el.parent !== undefined) el.parent -= 2;
  });
  ui.elements.push({ tag: "div", text: "Old promo banner", box: { x: 0, y: 300, w: 390, h: 40 } });
  // Button above the list now, blue slightly off, label bigger.
  const btn = ui.elements.find((e) => e.tag === "button");
  btn.box.y = 20;
  btn.bg = "#16A34A"; // green instead of blue
  const lbl = ui.elements.find((e) => e.text === "Pay now");
  lbl.box.y = 34;
  lbl.fontSize = 18;
  ui.elements.forEach((e, k) => (e.i = k));
  ui.elements.forEach((e) => {
    if (e.tag === "span") e.parent = ui.elements.indexOf(btn);
    if (e.tag === "li") e.parent = ui.elements.findIndex((x) => x.tag === "ul");
  });
  const { findings, summary } = run(d, ui);
  const kinds = findings.map((f) => `${f.severity}:${f.kind}:${f.designId ?? ""}`).sort();
  assert.deepEqual(kinds, [
    "high:extra:",
    "high:missing:hdr",
    "high:order:",
    "medium:fill:pay",
    "medium:font-size:payl",
    "medium:position:pay",
  ]);
  assert.match(findings.find((f) => f.kind === "missing").message, /descendants are missing too, including the texts "Checkout"/);
  assert.match(findings.find((f) => f.kind === "order").message, /List → Pay in the design but Pay → List in the UI/);
  assert.equal(findings.some((f) => f.kind === "position" && f.designId === "payl"), false, "the label moved with its button");
  assert.equal(summary.verdict, "differs");
});

test("tolerances: small offsets pass, larger ones are medium, >20% size is high; text compares top-left only", () => {
  const d = design();
  const ui = faithfulUi();
  ui.elements[1].box = { x: 18, y: 21, w: 140, h: 40 }; // title shifted by 2,3 with a much larger line box
  let r = run(d, ui);
  assert.deepEqual(r.findings, []);
  ui.elements[6].box = { x: 16, y: 232, w: 358, h: 60 }; // button 25% taller
  r = run(d, ui);
  assert.deepEqual(r.findings.map((f) => `${f.severity}:${f.kind}`), ["high:size"]);
  ui.elements[6].box.h = 54; // 6 px: beyond the 4 px tolerance, under 20%
  r = run(d, ui);
  assert.deepEqual(r.findings.map((f) => `${f.severity}:${f.kind}`), ["medium:size"]);
});

test("letter case differences are low, content differences on marker matches are high", () => {
  const d = design();
  const ui = faithfulUi();
  ui.elements[3].text = "ALPHA";
  ui.elements[4].marker = "S/List/Row[2]/Label";
  ui.elements[4].text = "Bravo";
  const { findings } = run(d, ui);
  assert.ok(findings.some((f) => f.severity === "low" && f.kind === "case" && f.designId === "row0"));
  assert.ok(findings.some((f) => f.severity === "high" && f.kind === "content" && f.designId === "row1"));
});

test("fields the source lacks are never compared", () => {
  const d = design();
  const ui = faithfulUi();
  ui.elements[1].fontSize = 30;
  ui.elements[1].fg = "#FF0000";
  const m = match(d, ui);
  assert.deepEqual(compare(d, ui, m, { fields: ["text", "bg"] }), []);
});

test("the effective background composites translucent layers over their ancestors", () => {
  const els = [
    { i: 0, bg: "rgb(0, 0, 0)" },
    { i: 1, parent: 0, bg: "rgba(255, 255, 255, 0.5)" },
    { i: 2, parent: 1, bg: "rgba(0, 0, 0, 0)" },
  ];
  const by = new Map(els.map((e) => [e.i, e]));
  const c = effectiveBg(els[2], by);
  assert.ok(Math.abs(c.r - 127.5) < 1);
});

test("pixel regions: a changed block is found, named after the design node there, texts can be ignored", () => {
  const a = blank(100, 100, [255, 255, 255]);
  const b = blank(200, 200, [255, 255, 255]); // a 2× screenshot
  for (let y = 100; y < 160; y++) for (let x = 20; x < 180; x++) b.data.set([220, 38, 38, 255], (y * 200 + x) * 4);
  const d = { frame: { w: 100 }, nodes: [{ id: "n", name: "Banner", box: { x: 10, y: 50, w: 80, h: 30 } }, { id: "all", name: "All", box: { x: 0, y: 0, w: 100, h: 100 } }] };
  const { regions } = pixelRegions(a, d.frame, b, { cell: 8, threshold: 12 });
  assert.equal(regions.length, 1);
  assert.ok(Math.abs(regions[0].box.y - 48) <= 8);
  assert.deepEqual(nodesAt(d, regions[0]).map((n) => n.id), ["n", "all"]);
  assert.equal(pixelRegions(a, d.frame, b, { ignore: [{ x: 0, y: 40, w: 100, h: 50 }] }).regions.length, 0);
});

test("image-only verification reports pixel regions and no element findings", () => {
  const d = design();
  const img = blank(390, 300, [255, 255, 255]);
  const shot = blank(390, 300, [255, 255, 255]);
  for (let y = 232; y < 280; y++) for (let x = 16; x < 374; x++) img.data.set([37, 99, 235, 255], (y * 390 + x) * 4);
  const res = verifyScreen({ design: d, snapshot: { viewport: { w: 390 }, elements: [], fields: [] }, designImg: img, uiImg: shot });
  assert.equal(res.summary.score, null);
  assert.ok(res.findings.every((f) => f.group === "Visual"));
  assert.match(res.findings[0].message, /S\/Pay/);
  assert.ok(res.hints.some((h) => /Image-only/.test(h)));
});

test("uiautomator XML: nesting, bounds, pen markers from resource-id, entities decoded", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" bounds="[0,0][1080,2400]">
  <node index="0" text="" resource-id="com.app:id/pen:Header" class="android.view.ViewGroup" bounds="[0,0][1080,154]">
    <node index="0" text="Tom &amp; Jerry" resource-id="" class="android.widget.TextView" bounds="[44,50][400,100]" />
  </node>
  <node index="1" text="" class="android.view.View" bounds="[0,0][0,0]" />
  <node index="2" text="Pay" content-desc="pen:Pay" class="android.widget.Button" bounds="[44,2000][1036,2132]" />
</node></hierarchy>`;
  const els = parseUiautomator(xml);
  assert.equal(els.length, 4);
  assert.equal(els[2].text, "Tom & Jerry");
  assert.equal(els[2].parent, 1);
  assert.equal(els[1].marker, "com.app:id/pen:Header");
  assert.equal(els[3].parent, 0);
  assert.equal(els[3].marker, "pen:Pay");
  assert.deepEqual(els[3].box, { x: 44, y: 2000, w: 992, h: 132 });
});

test("maestro hierarchy JSON: logs before the JSON are skipped, boxes and ids read", () => {
  const out = `Running on iPhone 16\n{"attributes":{"bounds":"[0,0][393,852]"},"children":[{"attributes":{"bounds":"[16,60][200,84]","text":"Checkout","resource-id":"pen:Header/Title"},"children":[]}]}`;
  const els = parseMaestro(out);
  assert.equal(els.length, 2);
  assert.equal(els[1].parent, 0);
  assert.equal(els[1].marker, "pen:Header/Title");
  assert.deepEqual(els[1].box, { x: 16, y: 60, w: 184, h: 24 });
  const img = blank(1179, 2556, [255, 255, 255]);
  // maestro reports iOS points: boxes stay as they are, colors are sampled at 3 px per point.
  const kept = withSampledColors(els, img, 3, { pixels: false });
  assert.deepEqual(kept[1].box, { x: 16, y: 60, w: 184, h: 24 });
  // uiautomator reports Android pixels: boxes are divided by the density.
  const scaled = withSampledColors(els, img, 3);
  assert.deepEqual(scaled[1].box, { x: 16 / 3, y: 20, w: 184 / 3, h: 8 });
});

// Fake fibers shaped like React Native's (Paper: stateNode is the view; Fabric: canonical.publicInstance).
const hostFiber = (type, props, stateNode, child) => ({ tag: 5, type, memoizedProps: props, stateNode, child });
const textFiber = (s) => ({ tag: 6, memoizedProps: s });
const chain = (...fibers) => {
  fibers.forEach((f, k) => (f.sibling = fibers[k + 1]));
  return fibers[0];
};
const view = (box) => ({ measureInWindow: (cb) => setTimeout(() => cb(box.x, box.y, box.w, box.h), 1) });

test("pen-probe walks host views, folds text spans, reads Paper and Fabric instances, converts colors", async () => {
  const title = hostFiber("RCTText", { style: { color: "#111111", fontSize: 20, fontWeight: "bold" }, testID: "pen:Header/Title" }, { canonical: { publicInstance: view({ x: 16, y: 18, w: 90, h: 24 }) } }, chain(textFiber("Check"), hostFiber("RCTVirtualText", {}, {}, textFiber("out"))));
  const header = hostFiber("RCTView", { style: [{ backgroundColor: "#F3F4F6" }, { borderRadius: 8 }], testID: "pen:Header" }, view({ x: 0, y: 0, w: 390, h: 56 }), title);
  const hidden = hostFiber("RCTView", {}, { measureInWindow: () => {} }, null); // never answers
  const root = { child: { tag: 1, child: chain(header, hidden) } };
  const flatten = (s) => (Array.isArray(s) ? Object.assign({}, ...s) : s);
  const processColor = (c) => ({ "#111111": 0xff111111, "#F3F4F6": 0xfff3f4f6 })[c];
  assert.equal(hostViews(root, { flatten }).length, 3);
  const els = await snapshotElements(root, { flatten, processColor, timeoutMs: 50 });
  assert.equal(els.length, 2, "the view that never measured is dropped");
  assert.equal(els[1].text, "Checkout");
  assert.equal(els[1].parent, 0);
  assert.equal(els[1].fontWeight, 700);
  assert.equal(els[1].fg, "rgba(17, 17, 17, 1)");
  assert.equal(els[0].bg, "rgba(243, 244, 246, 1)");
  assert.equal(els[0].radius, 8);
  assert.equal(els[0].marker, "pen:Header");
  assert.equal(colorString(0x80ff0000), "rgba(255, 0, 0, 0.502)");
  // A Fabric view without a public instance yet is measured through the fallback.
  const lazy = { child: chain(hostFiber("RCTView", { testID: "pen:Lazy" }, { node: { shadow: 1 }, canonical: { publicInstance: null } }, null)) };
  const viaFallback = await snapshotElements(lazy, { flatten, processColor, timeoutMs: 50, measureFallback: (sn, done) => (sn.node ? (done(1, 2, 3, 4), true) : false) });
  assert.deepEqual(viaFallback.map((e) => e.box), [{ x: 1, y: 2, w: 3, h: 4 }]);
  assert.equal(publicInstance(null), null);
});

test("a wider device: stretched and right-anchored elements pass, font sizes are not rescaled", () => {
  const d = design();
  d.nodes.push(node("close", "box", { x: 350, y: 12, w: 32, h: 32 }, { name: "Close", fill: parseColor("#111111") }));
  const ui = faithfulUi();
  const W = 411, extra = W - 390;
  for (const el of ui.elements) if (el.box.w >= 358) el.box.w += extra; // full-width rows, header and button stretch
  ui.elements.push({ i: ui.elements.length, tag: "button", box: { x: 350 + extra, y: 12, w: 32, h: 32 }, bg: "#111111" });
  ui.viewportW = W;
  const m = match(d, ui);
  assert.equal(m.pairs.get("close").how, "geometry");
  const findings = compare(d, ui, m, { fields: FIELDS, viewportW: W });
  assert.deepEqual(findings, []);
});

test("an unpainted grouping frame whose contents are present is low, not missing", () => {
  const d = design();
  const ui = faithfulUi();
  ui.elements[2].box = { x: 0, y: 72, w: 390, h: 600 }; // the list is not wrapped like the design (no element fits)
  const { findings } = run(d, ui);
  const f = findings.find((x) => x.designId === "list");
  assert.equal(f.severity, "low");
  assert.equal(f.kind, "group");
  assert.ok(!findings.some((x) => x.kind === "missing"));
});

test("many extra texts are summarized after the first eight", () => {
  const d = design();
  const ui = faithfulUi();
  for (let k = 0; k < 12; k++) ui.elements.push({ i: ui.elements.length, tag: "p", text: `Old item ${k}`, box: { x: 0, y: 400 + k * 20, w: 100, h: 18 } });
  const { findings } = run(d, ui);
  const extras = findings.filter((f) => f.kind === "extra");
  assert.equal(extras.length, 9);
  assert.match(extras[8].message, /4 more texts not in the design.*"Old item 8"/);
});

test("phone chrome drawn in a mockup is not compared", async () => {
  const { designNodes } = await import("../src/verify/design.js");
  const n = (id, name, type, abs, extra = {}) => ({ id, name, type, abs, children: [], ...extra });
  const bar = n("sb", "Status bar", "frame", { x: 0, y: 0, w: 390, h: 47 }, { fill: "#FFFFFF" });
  bar.children.push(n("clock", "Time", "text", { x: 20, y: 14, w: 40, h: 18 }, { content: "9:41" }));
  const title = n("t", "Title", "text", { x: 16, y: 60, w: 100, h: 24 }, { content: "Home" });
  const root = n("root", "Home", "frame", { x: 0, y: 0, w: 390, h: 844 });
  root.children.push(bar, title);
  const model = { root, nodes: new Map([root, bar, bar.children[0], title].map((x) => [x.id, x])), isToken: () => false, token: () => null };
  const d = designNodes(model);
  assert.deepEqual(d.nodes.map((x) => x.id), ["t"]);
  assert.deepEqual(d.deviceChrome.map((c) => c.name), ["Status bar"]);
});

test("order: sections side by side a pixel apart keep their left-to-right order", () => {
  const d = design();
  d.nodes.find((n) => n.id === "list").box = { x: 0, y: 72, w: 180, h: 144 };
  d.nodes.find((n) => n.id === "pay").box = { x: 200, y: 72, w: 174, h: 48 };
  d.nodes.find((n) => n.id === "payl").box = { x: 250, y: 86, w: 70, h: 20 };
  const ui = faithfulUi();
  ui.elements[2].box = { x: 0, y: 73, w: 180, h: 144 };
  ui.elements[6].box = { x: 200, y: 72, w: 174, h: 48 };
  ui.elements[7].box = { x: 251, y: 86, w: 68, h: 19 };
  const { findings } = run(d, ui);
  assert.ok(!findings.some((f) => f.kind === "order"));
});

test("a transparent UI container over the page background counts as the page's color", () => {
  const d = design();
  d.nodes.find((n) => n.id === "list").fill = parseColor("#FAFAFA");
  const ui = faithfulUi();
  ui.pageBg = "rgb(250, 250, 250)";
  const m = match(d, ui);
  assert.ok(!compare(d, ui, m, { fields: FIELDS }).some((f) => f.kind === "fill"));
  ui.pageBg = undefined;
  assert.ok(!compare(d, ui, match(d, ui), { fields: FIELDS }).some((f) => f.kind === "fill"), "#FAFAFA vs default white is within ΔE");
});

test("a missing card hides missing texts: the folded finding keeps high severity", () => {
  const d = design();
  d.nodes.push(node("card", "box", { x: 0, y: 400, w: 390, h: 100 }, { name: "Card", fill: parseColor("#EEEEEE") }));
  d.nodes.push(node("ct", "text", { x: 16, y: 420, w: 100, h: 20 }, { name: "Note", text: "Important note", ancestors: ["card"], color: parseColor("#111111"), fontSize: 14, fontWeight: 400 }));
  const { findings } = run(d, faithfulUi());
  const f = findings.find((x) => x.designId === "card");
  assert.equal(f.severity, "high");
  assert.match(f.message, /"Important note"/);
});

test("pen-probe reads the current fiber, not the stale alternate, even when a bailed-out parent points at the old tree", async () => {
  const { currentFiber } = await import("../probe/react-native/collect.js");
  // Live tree: root -> wrapper -> probe(fresh). The old tree's wrapper was never cloned again
  // (it bailed out), so the stale probe fiber's .return climbs to the OLD HostRoot.
  const fiberRoot = {};
  const liveRoot = { tag: 3, stateNode: fiberRoot };
  const oldRoot = { tag: 3, stateNode: fiberRoot, alternate: liveRoot };
  liveRoot.alternate = oldRoot;
  fiberRoot.current = liveRoot;
  const wrapper = { tag: 0, return: liveRoot };
  liveRoot.child = wrapper;
  const oldWrapper = { tag: 0, return: oldRoot };
  const fresh = { tag: 1, return: wrapper };
  const stale = { tag: 1, return: oldWrapper, alternate: fresh };
  fresh.alternate = stale;
  wrapper.child = fresh;
  assert.equal(currentFiber(stale), fresh);
  assert.equal(currentFiber(fresh), fresh);
  // A sibling subtree before it is walked too, without confusion.
  const toast = { tag: 0, return: liveRoot, sibling: wrapper };
  liveRoot.child = toast;
  assert.equal(currentFiber(stale), fresh);
});

test("icons: their fill is the glyph color, compared with the UI's icon color, never with the background", async () => {
  const { designNodes } = await import("../src/verify/design.js");
  const root = { id: "r", name: "S", type: "frame", abs: { x: 0, y: 0, w: 390, h: 844 }, children: [] };
  const icon = { id: "i", name: "Menu", type: "icon", abs: { x: 16, y: 16, w: 24, h: 24 }, children: [], fill: "#111111" };
  root.children.push(icon);
  const d = designNodes({ root, nodes: new Map([[root.id, root], [icon.id, icon]]), isToken: () => false, token: () => null });
  const n = d.nodes.find((x) => x.id === "i");
  assert.equal(n.fill, undefined);
  assert.equal(toHex(n.color), "#111111");
  const ui = { elements: [{ i: 0, tag: "svg", icon: true, marker: "Menu", box: { x: 16, y: 16, w: 24, h: 24 }, bg: "rgba(0, 0, 0, 0)", fg: "rgb(17, 17, 17)" }] };
  const m = match(d, ui);
  assert.deepEqual(compare(d, ui, m, { fields: FIELDS }), []);
  ui.elements[0].fg = "rgb(220, 38, 38)";
  assert.deepEqual(compare(d, ui, match(d, ui), { fields: FIELDS }).map((f) => f.kind), ["icon-color"]);
});

test("a wider device: a matched leaf that looks different is still reported (box-to-box pixels)", () => {
  const d = design();
  d.nodes.push(node("avatar", "box", { x: 350, y: 12, w: 32, h: 32 }, { name: "Avatar", fill: parseColor("#2563EB") }));
  const ui = faithfulUi();
  const W = 411, extra = W - 390;
  for (const el of ui.elements) if (el.box.w >= 358) el.box.w += extra;
  ui.elements.push({ i: ui.elements.length, tag: "img", marker: "Avatar", box: { x: 350 + extra, y: 12, w: 32, h: 32 }, bg: "#2563EB" });
  const designImg = blank(390, 100, [255, 255, 255]);
  for (let y = 12; y < 44; y++) for (let x = 350; x < 382; x++) designImg.data.set([37, 99, 235, 255], (y * 390 + x) * 4);
  const shot = blank(W, 100, [255, 255, 255]);
  for (let y = 12; y < 44; y++) for (let x = 371; x < 403; x++) shot.data.set([22, 163, 74, 255], (y * W + x) * 4); // a green picture instead
  const res = verifyScreen({ design: { ...d, nodes: d.nodes.filter((n) => n.box.y < 60) }, snapshot: { viewport: { w: W, h: 100 }, elements: ui.elements.filter((e) => e.box.y < 60 || e.tag === "img"), fields: FIELDS }, designImg, uiImg: shot });
  assert.ok(res.findings.some((f) => f.kind === "pixels" && f.designId === "avatar"), JSON.stringify(res.findings.map((f) => f.message)));
});

test("icon-font glyphs (private use area) are icons, not text, in pen-probe and native captures", async () => {
  const { snapshotElements, isIconGlyph } = await import("../probe/react-native/collect.js");
  assert.equal(isIconGlyph("\uF101"), true);
  assert.equal(isIconGlyph("Home"), false);
  const glyph = hostFiber("RCTText", { style: { color: "#2563EB", fontFamily: "Ionicons" } }, view({ x: 0, y: 0, w: 24, h: 24 }), textFiber("\uF101"));
  const els = await snapshotElements({ child: glyph }, { flatten: (x) => x, processColor: () => 0xff2563eb, timeoutMs: 50 });
  assert.equal(els[0].text, undefined);
  assert.equal(els[0].icon, true);
  assert.equal(els[0].fg, "rgba(37, 99, 235, 1)");
  const xml = `<hierarchy><node class="android.widget.TextView" text="&#61697;" bounds="[0,0][48,48]" /><node class="android.widget.TextView" text="Home" bounds="[0,48][96,96]" /></hierarchy>`;
  assert.deepEqual(parseUiautomator(xml).map((e) => e.text), [undefined, "Home"]);
});

test("icon glyphs mixed into text are dropped from it", async () => {
  const { withoutGlyphs } = await import("../probe/react-native/collect.js");
  assert.equal(withoutGlyphs("\uF101 Home"), "Home");
  assert.deepEqual(parseUiautomator(`<hierarchy><node text="&#61697; Home" bounds="[0,0][96,48]" /></hierarchy>`).map((e) => e.text), ["Home"]);
});

test("modern CSS colors: oklch (Tailwind v4), oklab and hsl are understood", () => {
  assert.equal(toHex(parseColor("oklch(62.3% 0.214 259.815)")), "#2B7FFF");
  assert.equal(toHex(parseColor("oklch(0.985 0.003 85)")), "#FBFAF8");
  assert.equal(toHex(parseColor("oklab(0.628 0.225 0.126)")), "#FF0000");
  assert.equal(toHex(parseColor("hsl(0, 100%, 50%)")), "#FF0000");
  assert.equal(toHex(parseColor("hsl(217 91% 60% / 50%)")), "#3C83F680");
  assert.equal(parseColor("oklch(none 0 0)"), null);
});

test("a missing wrapper whose main contents are present is medium and says so", () => {
  const d = design();
  d.nodes.push(node("shell", "shell", { x: 0, y: 780, w: 390, h: 64 }, { name: "Tab bar", fill: parseColor("#FFFFFF") }));
  d.nodes.push(node("bar", "box", { x: 16, y: 784, w: 358, h: 56 }, { name: "Bar", fill: parseColor("#111111"), ancestors: ["shell"] }));
  const ui = faithfulUi();
  ui.elements.push({ i: ui.elements.length, tag: "nav", box: { x: 16, y: 784, w: 358, h: 56 }, bg: "#111111" });
  const { findings } = run(d, ui);
  const f = findings.find((x) => x.designId === "shell");
  assert.equal(f.severity, "medium");
  assert.match(f.message, /1 of its contents are present \(Bar\): the container itself is what differs/);
});
