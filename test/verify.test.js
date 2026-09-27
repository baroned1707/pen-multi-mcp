// verify end to end: a design built with the real engine, rendered pages in headless Chromium.
// The faithful page is the design's own HTML export; drifted pages re-create what agents did in
// practice (old UI kept, shell never ported, sections reordered, wrong color and type).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readPng } from "../src/verify/image.js";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-verify-")));
const file = path.join(dir, "app.pen");
let client;
const exec = async (input) => {
  const res = await call(client, "execute", { filePath: file, input });
  assert.ok(!res.isError, text(res));
  return text(res);
};
const url = (name) => `file://${path.join(dir, name)}`;
const verify = (args) => call(client, "verify", { filePath: file, target: "Checkout · light", ...args });
// Output names carry a hash of the .pen path: find them by prefix.
const out = (sub, ext) => {
  const d = path.join(dir, "design-verify", sub);
  const f = fs.readdirSync(d).find((n) => /^checkout-light-[0-9a-f]{6}\./.test(n) && n.endsWith(ext));
  return path.join(d, f);
};
const report = () => JSON.parse(fs.readFileSync(out("", ".json"), "utf8"));
const kinds = (rep, severity) => rep.findings.filter((f) => f.severity === severity).map((f) => `${f.kind}:${f.address ?? ""}`).sort();

before(async () => {
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" } });
  await exec(`SetVariables({ bg: { type: "color", value: "#FFFFFF" }, ink: { type: "color", value: "#111111" }, brand: { type: "color", value: "#2563EB" } })`);
  await exec(`btn = Insert(document, { type: "frame", name: "C/Button", reusable: true, x: 0, y: -400, width: 358, height: 48, layout: "horizontal", justifyContent: "center", alignItems: "center", fill: "$brand", cornerRadius: 10 });
  Insert(btn, { type: "text", name: "Label", content: "Pay now", fill: "#FFFFFF", fontFamily: "Inter", fontSize: 16, fontWeight: "600" });
  s = Insert(document, { type: "frame", name: "Checkout · light", x: 0, y: 0, width: 390, height: 844, layout: "vertical", clip: true, fill: "$bg" });
  h = Insert(s, { type: "frame", name: "Header", width: "fill_container", height: 56, padding: [0, 16], alignItems: "center", fill: "#F3F4F6" });
  Insert(h, { type: "text", name: "Title", content: "Checkout", fill: "$ink", fontFamily: "Inter", fontSize: 20, fontWeight: "700" });
  body = Insert(s, { type: "frame", name: "Content", width: "fill_container", height: "fill_container", layout: "vertical", gap: 12, padding: 16 });
  sum = Insert(body, { type: "frame", name: "Summary", width: "fill_container", height: 80, padding: 16, fill: "#EEF2FF", cornerRadius: 12, layout: "vertical", gap: 4 });
  Insert(sum, { type: "text", name: "Total", content: "Total 42.00", fill: "$ink", fontFamily: "Inter", fontSize: 18, fontWeight: "600" });
  list = Insert(body, { type: "frame", name: "Items", width: "fill_container", layout: "vertical" });
  for (const t of ["Alpha", "Beta", "Gamma"]) { r = Insert(list, { type: "frame", name: "Row", width: "fill_container", height: 48, alignItems: "center" }); Insert(r, { type: "text", name: "Label", content: t, fill: "$ink", fontFamily: "Inter", fontSize: 16 }); }
  Insert(body, { type: "ref", ref: btn, name: "Primary" });
  tab = Insert(s, { type: "frame", name: "Tab bar", layoutPosition: "absolute", x: 0, y: 788, width: 390, height: 56, fill: "#111111", layout: "horizontal", justifyContent: "space_around", alignItems: "center" });
  for (const t of ["Home", "Cart", "Me"]) Insert(tab, { type: "text", name: t, content: t, fill: "#FFFFFF", fontFamily: "Inter", fontSize: 12 });`);
  const ref = await call(client, "inspect", { filePath: file, target: "Checkout · light", format: "html-ref" });
  assert.ok(!ref.isError, text(ref));
  const faithful = fs.readFileSync(path.join(dir, "design-ref", "Checkout_light.html"), "utf8");
  fs.writeFileSync(path.join(dir, "faithful.html"), faithful);
  const drift = (strip) => `<script>addEventListener("DOMContentLoaded", () => {
    const q = (m) => document.querySelector('[data-pen="' + m + '"]');
    q("Tab bar").remove();
    const promo = document.createElement("div");
    promo.textContent = "Old promo banner";
    promo.style.cssText = "padding:12px;background:#FDE68A;font:14px Inter";
    q("Summary").before(promo);
    q("Summary").before(q("Items"));
    q("Title").style.color = "#DC2626";
    q("Total").style.fontSize = "24px";
    ${strip ? 'document.querySelectorAll("[data-pen]").forEach((e) => e.removeAttribute("data-pen"));' : ""}
  });</script>`;
  fs.writeFileSync(path.join(dir, "drift.html"), faithful.replace("</body>", `${drift(false)}</body>`));
  fs.writeFileSync(path.join(dir, "drift-nomarkers.html"), faithful.replace("</body>", `${drift(true)}</body>`));
});

after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the design's own HTML matches it, and the report, snapshot and contact sheet are written", async () => {
  const res = await verify({ source: { kind: "web", url: url("faithful.html") } });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /Verdict: MATCH — 0 high, 0 medium/);
  const rep = report();
  assert.equal(rep.summary.verdict, "match");
  assert.equal(rep.summary.matched, rep.summary.compared);
  const sheet = readPng(rep.files.contactSheet);
  assert.ok(sheet.width > 390 * 3, "three columns");
  assert.ok(fs.existsSync(rep.files.snapshot));
});

const planted = {
  high: ["extra:", "missing:Checkout · light/Tab bar", "order:"],
  medium: [
    "font-size:Checkout · light/Content/Summary/Total",
    "position:Checkout · light/Content/Items",
    "position:Checkout · light/Content/Primary",
    "position:Checkout · light/Content/Summary",
    "text-color:Checkout · light/Header/Title",
  ],
};

test("drift is reported as exactly the planted differences", async () => {
  const res = await verify({ source: { kind: "web", url: url("drift.html") } });
  assert.match(text(res), /Verdict: DIFFERS — 3 high, 5 medium/);
  assert.match(text(res), /missing: shell "Tab bar".*"Home", "Cart", "Me"/);
  assert.match(text(res), /extra: "Old promo banner"/);
  assert.match(text(res), /order: sections run Summary → Items → Primary in the design but Items → Summary → Primary in the UI/);
  const rep = report();
  assert.deepEqual(kinds(rep, "high"), planted.high);
  assert.deepEqual(kinds(rep, "medium"), planted.medium);
});

test("without markers the same differences are found, with a hint to add markers", async () => {
  const res = await verify({ source: { kind: "web", url: url("drift-nomarkers.html") } });
  const rep = report();
  assert.deepEqual(kinds(rep, "high"), planted.high);
  assert.deepEqual(kinds(rep, "medium"), planted.medium);
  assert.equal(rep.summary.by.marker, 0);
  assert.match(text(res), /No markers found\. Add data-pen=/);
});

test("a saved snapshot can be verified again, and a screenshot alone gives named pixel regions", async () => {
  const snap = out("captures", ".json");
  const again = await verify({ snapshot: snap });
  assert.match(text(again), /3 high, 5 medium/);
  fs.copyFileSync(out("captures", ".png"), path.join(dir, "shot.png"));
  const img = await verify({ source: { kind: "image", path: "shot.png", width: 390 } });
  assert.match(text(img), /score n\/a \(image only\)/);
  assert.match(text(img), /pixels differ in .* — design there: Checkout · light\/Tab bar/);
});

test("contact_sheet draws a row per report and returns the image inline", async () => {
  const res = await call(client, "contact_sheet", { reports: [out("", ".json")], savePath: "sheet.png" });
  assert.ok(!res.isError, text(res));
  const image = res.content.find((c) => c.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.ok(Buffer.from(image.data, "base64").length > 1000);
  assert.ok(fs.existsSync(path.join(dir, "sheet.png")));
});

test("capture summarizes a page; an unknown variant lists the screen's variants", async () => {
  const cap = await call(client, "capture", { source: { kind: "web", url: url("faithful.html") } });
  assert.match(text(cap), /Captured web .*: \d+ elements \(\d+ with text, \d+ with pen markers\)/);
  const bad = await verify({ theme: "dark", source: { kind: "web", url: url("faithful.html") } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /no frame for theme dark\. Variants: Checkout · light/);
  const none = await call(client, "verify", { filePath: file, target: "Checkout · light" });
  assert.match(text(none), /Pass source/);
});

test("web capture skips hidden and clipped text and keeps inline paragraphs whole", async () => {
  fs.writeFileSync(
    path.join(dir, "vis.html"),
    `<body style="margin:0"><div style="opacity:0"><span>Hidden text</span></div><div style="height:0;overflow:hidden"><span>Collapsed</span></div>
     <p>Line1<br>Line2</p><p>Agree to <a href="#">Terms</a> now</p><details><summary>More</summary><p>Inside</p></details><button>Pay <b>now</b></button></body>`,
  );
  const cap = await call(client, "capture", { source: { kind: "web", url: url("vis.html") }, savePath: "vis-capture" });
  assert.ok(!cap.isError, text(cap));
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "vis-capture.json"), "utf8"));
  assert.deepEqual(snap.elements.filter((e) => e.text).map((e) => e.text), ["Line1 Line2", "Agree to Terms now", "More", "Pay now"]);
});

test("a frame id with a theme that has no variant is an error, not a silent comparison of the wrong frame", async () => {
  const id = report().target.id;
  const res = await call(client, "verify", { filePath: file, target: id, theme: "dark", source: { kind: "web", url: url("faithful.html") } });
  assert.equal(res.isError, true);
  assert.match(text(res), /no frame for theme dark/);
});

test("web capture: deep content under body overflow-x, escaped fixed text, separate buttons, marked labels, no checkbox value, icon fonts, truncation, scroll reveal, shadow DOM", async () => {
  fs.writeFileSync(
    path.join(dir, "r2.html"),
    `<html><head><style>html,body{height:100%;margin:0} body{overflow-x:hidden} .reveal{opacity:0}.reveal.on{opacity:1} .clip{width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style></head><body>
<div style="height:1200px">top</div><section><h2>Deep section</h2></section>
<div style="overflow:hidden;height:10px"><div style="position:fixed;bottom:0">Escaped fixed text</div></div>
<div><button>Cancel</button> <button>OK</button></div>
<button data-pen="Button"><svg width="10" height="10"></svg> <span data-pen="Button/Label">Save</span></button>
<label><input type="checkbox"> Remember me</label><select><option>Choice A</option></select>
<span style="font-family:'Material Icons'">home</span>
<p class="clip">A very long title that is cut</p>
<div class="reveal" id="rv">Revealed on scroll</div><my-el></my-el>
<script>new IntersectionObserver((es)=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('on'))).observe(document.getElementById('rv'));
customElements.define('my-el', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<b>Shadow text</b>'; } });</script></body></html>`,
  );
  const cap = await call(client, "capture", { source: { kind: "web", url: url("r2.html") }, savePath: "r2-capture" });
  assert.ok(!cap.isError, text(cap));
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "r2-capture.json"), "utf8"));
  const texts = snap.elements.filter((e) => e.text).map((e) => e.text + (e.truncated ? " [truncated]" : "") + (e.fixed ? " [fixed]" : ""));
  assert.deepEqual(texts, ["top", "Deep section", "Escaped fixed text [fixed]", "Cancel", "OK", "Save", "Remember me", "Choice A", "A very long title that is cut [truncated]", "Revealed on scroll", "Shadow text"]);
});

test("web capture: screen-reader-only and off-page text is not shown text; content-visibility sections render; icons carry their color; scrolling text is not truncated", async () => {
  const many = Array.from({ length: 12 }, (_, k) => `<section style="content-visibility:auto;contain-intrinsic-size:600px;height:600px"><h3>Section ${k}</h3></section>`).join("");
  fs.writeFileSync(
    path.join(dir, "r3.html"),
    `<body style="margin:0"><style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}</style>
     <button><svg width="16" height="16" style="fill:#DC2626"><rect width="16" height="16"/></svg><span class="sr-only">Open main menu</span></button>
     <a href="#main" style="position:absolute;left:-9999px">Skip to content</a>
     <nav style="position:fixed;top:0;left:0;width:280px;height:100%;transform:translateX(-100%)"><a>Home</a></nav>
     <h1 style="overflow:hidden;line-height:1">Tight heading</h1><p style="overflow-x:auto;white-space:nowrap;width:100px">Horizontally scrolling text that is long</p>${many}</body>`,
  );
  const cap = await call(client, "capture", { source: { kind: "web", url: url("r3.html") }, savePath: "r3-capture" });
  assert.ok(!cap.isError, text(cap));
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "r3-capture.json"), "utf8"));
  const texts = snap.elements.filter((e) => e.text).map((e) => e.text + (e.truncated ? " [truncated]" : ""));
  assert.deepEqual(texts, ["Tight heading", "Horizontally scrolling text that is long", ...Array.from({ length: 12 }, (_, k) => `Section ${k}`)]);
  const svg = snap.elements.find((e) => e.tag === "svg");
  assert.equal(svg.fg, "rgb(220, 38, 38)");
  assert.equal(svg.icon, true);
});

test("capture refuses to overwrite a file that is not a capture", async () => {
  fs.writeFileSync(path.join(dir, "keep.json"), JSON.stringify({ name: "precious" }));
  const res = await call(client, "capture", { source: { kind: "web", url: url("faithful.html") }, savePath: "keep.json" });
  assert.equal(res.isError, true);
  assert.match(text(res), /not a capture; refusing to overwrite/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "keep.json"), "utf8")).name, "precious");
});

test("web capture: nested screen-reader-only text stays hidden; SVG color comes from its painted shapes; an unrelated PNG is never overwritten", async () => {
  fs.writeFileSync(
    path.join(dir, "r4.html"),
    `<body style="margin:0"><style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>
     <button>X<span class="sr-only"><span>Close dialog</span></span></button>
     <div style="clip-path:inset(50%);position:absolute"><p>Section heading</p></div>
     <svg id="a" width="24" height="24" fill="none"><path d="M0 0h24v24H0z" fill="#2563EB"/></svg>
     <svg id="b" width="24" height="24" fill="none" stroke="#16A34A"><path d="M0 0l24 24"/></svg>
     <p style="visibility:hidden">Hidden parent <span style="visibility:visible">Visible child</span></p></body>`,
  );
  const cap = await call(client, "capture", { source: { kind: "web", url: url("r4.html") }, savePath: "r4-capture" });
  assert.ok(!cap.isError, text(cap));
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "r4-capture.json"), "utf8"));
  assert.deepEqual(snap.elements.filter((e) => e.text).map((e) => e.text), ["X", "Visible child"]);
  const svgs = snap.elements.filter((e) => e.tag === "svg");
  assert.deepEqual(svgs.map((e) => e.fg), ["rgb(37, 99, 235)", "rgb(22, 163, 74)"]);
  fs.writeFileSync(path.join(dir, "logo.png"), "not a capture");
  const res = await call(client, "capture", { source: { kind: "web", url: url("r4.html") }, savePath: "logo.png" });
  assert.equal(res.isError, true);
  assert.equal(fs.readFileSync(path.join(dir, "logo.png"), "utf8"), "not a capture");
  const again = await call(client, "capture", { source: { kind: "web", url: url("r4.html") }, savePath: "r4-capture" });
  assert.ok(!again.isError, "a previous capture may be replaced");
});
