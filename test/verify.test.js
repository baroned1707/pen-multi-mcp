// verify end to end: a design built with the real engine, rendered pages in headless Chromium.
// The faithful page is the design's own HTML export; drifted pages re-create what agents did in
// practice (old UI kept, shell never ported, sections reordered, wrong color and type).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  execFileSync("git", ["init", "-q"], { cwd: dir }); // a project: markers are searched in its repository
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

test("findings point at the code (file:line from markers) and name the design token; the worst come as close-ups", async () => {
  const res = await verify({ source: { kind: "web", url: url("drift.html") } });
  const t = text(res);
  assert.match(t, /text color: #DC2626 in the UI, #111111 in the design .* Design token \$ink\. → [\w-]+\.html:\d+ \(\+\d+ other places with this marker\)/);
  const images = res.content.filter((c) => c.type === "image");
  assert.equal(images.length, 3, "three close-ups by default");
  assert.match(t, /Finding \d+ \[high\] close-up — left: design, right: app\./);
  const none = await verify({ source: { kind: "web", url: url("drift.html") }, crops: 0 });
  assert.equal(none.content.filter((c) => c.type === "image").length, 0);
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

test("SVG color ignores masks and definitions, reads sprite <use> icons colored by a class; a lone PNG left in design-verify does not block verify", async () => {
  fs.writeFileSync(
    path.join(dir, "r5.html"),
    `<body style="margin:0"><style>.sprite{fill:#2563EB}</style>
     <svg width="0" height="0" style="position:absolute"><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></svg>
     <svg id="m" width="24" height="24" fill="none"><mask id="m0"><rect width="24" height="24" fill="#D9D9D9"/></mask><g mask="url(#m0)"><path d="M0 0h24v24H0z" fill="#1C1B1F"/></g></svg>
     <svg class="sprite" width="24" height="24"><use href="#s"/></svg></body>`,
  );
  const cap = await call(client, "capture", { source: { kind: "web", url: url("r5.html") }, savePath: "r5-capture" });
  assert.ok(!cap.isError, text(cap));
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "r5-capture.json"), "utf8"));
  assert.deepEqual(snap.elements.filter((e) => e.tag === "svg" && e.box.w > 0).map((e) => e.fg), ["rgb(28, 27, 31)", "rgb(37, 99, 235)"]);
  // A failed capture left only its screenshot behind: the next verify replaces it.
  const png = out("captures", ".png");
  fs.rmSync(png.replace(/\.png$/, ".json"));
  const res = await verify({ source: { kind: "web", url: url("faithful.html") } });
  assert.ok(!res.isError, text(res));
});

test("1px screen-reader-only boxes (Drupal clip rect(1px…), plain 1px overflow hidden) hide nested text; <use> of a filled shape in <defs> keeps its color", async () => {
  fs.writeFileSync(
    path.join(dir, "r6.html"),
    `<body style="margin:0"><span style="clip:rect(1px,1px,1px,1px);height:1px;margin:-1px;overflow:hidden;position:absolute;width:1px"><span>DrupalNested</span></span>
     <span style="width:1px;height:1px;overflow:hidden;position:absolute"><span>PlainNested</span></span>
     <span style="width:1px;height:1px;overflow:hidden;position:relative;display:inline-block"><span style="position:fixed;top:100px;left:10px">Escapes</span></span>
     <svg width="24" height="24"><defs><path id="p" d="M0 0h24v24H0z" fill="#f00"/></defs><use href="#p"/></svg><p>Shown</p></body>`,
  );
  const cap = await call(client, "capture", { source: { kind: "web", url: url("r6.html") }, savePath: "r6-capture" });
  assert.ok(!cap.isError, text(cap));
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "r6-capture.json"), "utf8"));
  assert.deepEqual(snap.elements.filter((e) => e.text).map((e) => e.text), ["Escapes", "Shown"]);
  assert.equal(snap.elements.find((e) => e.tag === "svg").fg, "rgb(255, 0, 0)");
});

test("web capture: ::before/::after text joins the element's text; same-origin iframes are read at their place", async () => {
  fs.writeFileSync(
    path.join(dir, "r7.html"),
    `<body style="margin:0"><style>.new::after{content:"New"} .req::before{content:"* "} .ico::before{content:"\\e900";font-family:icomoon}</style>
     <p class="new">Feature </p><label class="req">Email</label><span class="ico"></span>
     <iframe srcdoc="<body style='margin:0'><h2 style='margin:0'>Inside frame</h2></body>" style="position:absolute;left:40px;top:200px;width:200px;height:80px;border:2px solid #000"></iframe></body>`,
  );
  const cap = await call(client, "capture", { source: { kind: "web", url: url("r7.html") }, savePath: "r7-capture" });
  assert.ok(!cap.isError, text(cap));
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "r7-capture.json"), "utf8"));
  assert.deepEqual(snap.elements.filter((e) => e.text).map((e) => e.text), ["Feature New", "* Email", "Inside frame"]);
  const inner = snap.elements.find((e) => e.text === "Inside frame");
  assert.deepEqual([inner.box.x, inner.box.y], [42, 202]);
  assert.equal(snap.elements.find((e) => e.tag === "iframe").frame, "same-origin");
});

test("web capture turns oklch, hsl and color-mix into sRGB so colors are always compared", async () => {
  fs.writeFileSync(path.join(dir, "r8.html"), `<body style="margin:0;background:oklch(0.985 0.003 85)"><p style="color:oklch(62.3% 0.214 259.815);background:color-mix(in srgb, red 50%, blue);border:1px solid hsl(0 100% 50%)">Colors</p></body>`);
  const cap = await call(client, "capture", { source: { kind: "web", url: url("r8.html") }, savePath: "r8-capture" });
  assert.ok(!cap.isError, text(cap));
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "r8-capture.json"), "utf8"));
  const p = snap.elements.find((e) => e.text === "Colors");
  assert.deepEqual([p.fg, p.bg, p.borderColor, snap.pageBg], ["rgba(43, 127, 255, 1)", "rgba(128, 0, 128, 1)", "rgb(255, 0, 0)", "rgba(251, 250, 248, 1)"]);
});

test("a password is never captured as text", async () => {
  fs.writeFileSync(path.join(dir, "pw.html"), `<body style="margin:0"><input type="password" value="hunter2secret"><input type="password" placeholder="Password"></body>`);
  const cap = await call(client, "capture", { source: { kind: "web", url: url("pw.html") }, savePath: "pw-capture" });
  assert.ok(!cap.isError, text(cap));
  const raw = fs.readFileSync(path.join(dir, "pw-capture.json"), "utf8");
  assert.doesNotMatch(raw, /hunter2/);
  const snap = JSON.parse(raw);
  assert.deepEqual(snap.elements.filter((e) => e.text).map((e) => e.text), ["•••••••••••••".slice(0, 12), "Password"]);
});

test("cross-origin iframes are read through the browser and placed at their frame", async () => {
  const http = await import("node:http");
  const inner = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<body style="margin:0"><h2 style="margin:0;font-size:18px">Cross origin content</h2></body>`);
  });
  await new Promise((r) => inner.listen(0, "127.0.0.1", r));
  try {
    fs.writeFileSync(path.join(dir, "xo.html"), `<body style="margin:0"><iframe src="http://127.0.0.1:${inner.address().port}/" style="position:absolute;left:40px;top:100px;width:220px;height:80px;border:3px solid #000"></iframe></body>`);
    const cap = await call(client, "capture", { source: { kind: "web", url: url("xo.html") }, savePath: "xo-capture" });
    assert.ok(!cap.isError, text(cap));
    const snap = JSON.parse(fs.readFileSync(path.join(dir, "xo-capture.json"), "utf8"));
    const h2 = snap.elements.find((e) => e.text === "Cross origin content");
    assert.deepEqual([h2.box.x, h2.box.y], [43, 103]);
    assert.match(h2.selector, /^iframe > /);
  } finally {
    inner.close();
  }
});

test("iframes: hidden ones are not read; a scrolled frame shows only what is visible through it", async () => {
  const http = await import("node:http");
  const pages = {
    "/text": `<body style="margin:0"><h2 style="margin:0">Framed text</h2></body>`,
    "/list": `<body style="margin:0">${Array.from({ length: 40 }, (_, k) => `<p style="margin:0;height:50px">Row ${k}</p>`).join("")}<script>scrollTo(0, 1000)</script></body>`,
  };
  const other = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pages[req.url] ?? "");
  });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const o = `http://127.0.0.1:${other.address().port}`;
  try {
    fs.writeFileSync(
      path.join(dir, "frames.html"),
      `<body style="margin:0"><iframe src="${o}/text" style="visibility:hidden;width:200px;height:40px;border:0"></iframe>
       <div style="opacity:0"><iframe src="${o}/text" style="width:200px;height:40px;border:0"></iframe></div>
       <div style="width:0;height:0;overflow:hidden"><iframe src="${o}/text" style="width:200px;height:40px;border:0"></iframe></div>
       <iframe src="${o}/list" style="position:absolute;left:0;top:300px;width:200px;height:100px;border:0"></iframe></body>`,
    );
    const cap = await call(client, "capture", { source: { kind: "web", url: url("frames.html") }, savePath: "frames-capture" });
    assert.ok(!cap.isError, text(cap));
    const snap = JSON.parse(fs.readFileSync(path.join(dir, "frames-capture.json"), "utf8"));
    const texts = snap.elements.filter((e) => e.text).map((e) => `${e.text}@${e.box.y}`);
    assert.deepEqual(texts, ["Row 20@300", "Row 21@350"]);
  } finally {
    other.close();
  }
});

test("code-to-design: proposed edits for clear causes; applied to a copy of the design, those differences are gone", async () => {
  await call(client, "save", { filePath: file });
  const copy = path.join(dir, "follow-code.pen");
  fs.copyFileSync(file, copy);
  const src = { kind: "web", url: url("drift.html") };
  const res = await call(client, "verify", { filePath: copy, target: "Checkout · light", source: src, direction: "code-to-design", crops: 0 });
  const t = text(res);
  assert.match(t, /## Proposed design edits \(code → design\)/);
  assert.match(t, /Update\("\w+", \{"fill":"#DC2626"\}\) {2}\/\/ the code's text color/);
  assert.match(t, /Update\("\w+", \{"fontSize":24\}\) {2}\/\/ the code's font size/);
  assert.match(t, /Update\("\w+", \{"enabled":false\}\) {2}\/\/ the code no longer shows it — hidden, not deleted/);
  assert.match(t, /Insert\("\w+", \{"type":"text","name":"Old promo banner","content":"Old promo banner"/);
  assert.match(t, /No edit proposed for: .*layout: the cause \(gap, padding, order, sizing\) is not clear/);
  assert.doesNotMatch(t, /Fix the high findings first/);
  const ops = [...t.matchAll(/^\d+\. ((?:Update|Insert)\(.*\))  \/\//gm)].map((m) => m[1]);
  const applied = await call(client, "execute", { filePath: copy, input: ops.join("\n") });
  assert.ok(!applied.isError, text(applied));
  const after = await call(client, "verify", { filePath: copy, target: "Checkout · light", source: src, crops: 0 });
  const rep = JSON.parse(fs.readFileSync(/- report: (.*)/.exec(text(after))[1], "utf8"));
  const left = rep.findings.map((f) => f.kind);
  for (const k of ["text-color", "font-size", "missing"]) assert.ok(!left.includes(k), `${k} fixed in the design: ${left.join(", ")}`);
  assert.ok(!rep.findings.some((f) => f.kind === "extra" && /Old promo banner/.test(f.message)), "the promo text now exists in the design");
});
