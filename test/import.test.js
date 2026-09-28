// Code -> design against the real engine and headless Chromium: import a running page as a
// frame, verify it round trip, routes from .pen-multi.json, and sync_status.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-import-")));
const file = path.join(dir, "app.pen");
let client;
let frameId;

before(async () => {
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" } });
  fs.writeFileSync(
    path.join(dir, "orders.html"),
    `<body style="margin:0;font-family:Arial;background:#FAFAFA">
<header style="height:56px;background:#111827;color:#fff;display:flex;align-items:center;padding:0 16px"><h1 style="margin:0;font-size:20px">Orders</h1></header>
<main style="padding:16px;display:flex;flex-direction:column;gap:12px">
<div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:16px"><p style="margin:0;font-size:16px;font-weight:600;color:#111827">Order #1042</p><p style="margin:4px 0 0;font-size:14px;color:#6B7280">2 items · $38.00</p></div>
<button style="height:48px;border:0;border-radius:10px;background:#2563EB;color:#fff;font-size:16px;font-weight:600">New order</button>
<svg width="24" height="24"><circle cx="12" cy="12" r="10" fill="#16A34A"/></svg>
</main></body>`,
  );
  const res = await call(client, "execute", { filePath: file, input: 'SetVariables({ ink: { type: "color", value: "#111827" }, brand: { type: "color", value: "#2563EB" } })' });
  assert.ok(!res.isError, text(res));
});

after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("import_ui rebuilds the page as a frame: texts, painted boxes on tokens, image crops", async () => {
  const res = await call(client, "import_ui", { filePath: file, source: { kind: "web", url: `file://${path.join(dir, "orders.html")}` }, name: "Orders" });
  assert.ok(!res.isError, text(res));
  const t = text(res);
  frameId = /"Orders" \((\S+)\)/.exec(t)[1];
  assert.match(t, /Imported \d+ nodes/);
  assert.match(t, /4 texts, 1 image crops, [1-9]\d* fills on tokens/);
  assert.ok(fs.readdirSync(path.join(dir, "images")).some((f) => /^import-orders-.*\.png$/.test(f)));
  const out = text(await call(client, "execute", { filePath: file, input: `Print("N", JSON.stringify(Get(${JSON.stringify(frameId)}, (n) => n.type === "text" ? [n.content, n.fill] : undefined)))` }));
  const texts = JSON.parse(/N (.*)/.exec(out)[1]);
  assert.deepEqual(texts.map(([c]) => c).sort(), ["2 items · $38.00", "New order", "Order #1042", "Orders"]);
  assert.ok(texts.some(([c, f]) => c === "Order #1042" && f === "$ink"), "a text color equal to a token uses the token");
});

test("the imported frame verifies as a MATCH against the same page (round trip)", async () => {
  const res = await call(client, "verify", { filePath: file, target: frameId, source: { kind: "web", url: `file://${path.join(dir, "orders.html")}` } });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /Verdict: MATCH/);
});

test("verify finds the page through .pen-multi.json routes; sync_status reports match, stale and never", async () => {
  fs.writeFileSync(path.join(dir, ".pen-multi.json"), JSON.stringify({ baseUrl: `file://${dir}/`, routes: { Orders: "orders.html" } }));
  const viaRoute = await call(client, "verify", { filePath: file, target: "Orders", source: { kind: "web" } });
  assert.ok(!viaRoute.isError, text(viaRoute));
  assert.match(text(viaRoute), /vs web file:\/\/.*orders\.html/);
  await call(client, "save", { filePath: file });
  let status = text(await call(client, "sync_status", { filePath: file }));
  assert.match(status, /Orders \| match \| 390 \| – \| orders\.html \| 0 high, 0 medium/);

  // A second screen never verified, then a design change after the last verify.
  await call(client, "execute", { filePath: file, input: `Insert(document, { type: "frame", name: "Settings", x: 3000, y: 0, width: 390, height: 844, fill: "#FFFFFF" })` });
  await call(client, "execute", { filePath: file, input: `Update(${JSON.stringify(frameId)}, { fill: "#F5F5F5" })` });
  await call(client, "save", { filePath: file });
  status = text(await call(client, "sync_status", { filePath: file }));
  assert.match(status, /Orders \| match \(stale\)/);
  assert.match(status, /Settings \| never/);
  assert.match(status, /## Verify next\n- verify\(\{ target: "[^"]+", source: \{ kind: "web" \} \}\) {2}\/\/ Orders: match \(stale\)/);

  const noRoute = await call(client, "verify", { filePath: file, target: "Settings", source: { kind: "web" } });
  assert.equal(noRoute.isError, true);
  assert.match(text(noRoute), /has no route for "Settings"/);
});

test("round trip on hard cases: label with input, padded text, inline code, tall line, icon button, fixed tab bar on a long page", async () => {
  fs.writeFileSync(
    path.join(dir, "hard.html"),
    `<body style="margin:0;font-family:Arial;background:#fff">
<label style="display:block;padding:8px">Email <input style="border:1px solid #ccc;width:120px"></label>
<div style="padding:24px;background:#eee">Padded card text</div>
<p style="margin:16px">Use <code style="background:#ddd">npm</code> here</p>
<p style="margin:0 16px;font-size:16px;line-height:40px">Tall line</p>
<button style="margin:16px;width:200px;height:44px;background:#2563EB;color:#fff;border:0">Save <svg width="16" height="16"><rect width="16" height="16" fill="#fff"/></svg></button>
<div style="height:1400px"></div>
<nav style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#111827;color:#fff;display:flex;align-items:center;justify-content:space-around"><span>Home</span><span>Me</span></nav>
</body>`,
  );
  const src = { kind: "web", url: `file://${path.join(dir, "hard.html")}` };
  const imp = await call(client, "import_ui", { filePath: file, source: src, name: "Hard / cases" });
  assert.ok(!imp.isError, text(imp));
  const id = /"Hard – cases" \((\S+)\)/.exec(text(imp))?.[1];
  assert.ok(id, `a name without "/": ${text(imp)}`);
  const kids = JSON.parse(/N (.*)/.exec(text(await call(client, "execute", { filePath: file, input: `Print("N", JSON.stringify(Get(${JSON.stringify(id)}, (n) => n.name)))` })))[1]);
  assert.ok(kids.some((n) => /input/i.test(n)), `the input inside the label is kept: ${kids.join(", ")}`);
  assert.ok(kids.some((n) => /code/i.test(n)), "the inline code box is kept");
  const v = await call(client, "verify", { filePath: file, target: id, source: src });
  assert.match(text(v), /Verdict: MATCH/, text(v).split("\n").filter((l) => /\[(high|medium)\]|Verdict/.test(l)).join("\n"));
});

test("round trip: sticky heading mid page, dark inline code, padded input; the paragraph text paints above its code box", async () => {
  fs.writeFileSync(
    path.join(dir, "more.html"),
    `<body style="margin:0;font-family:Arial;background:#fff">
<input style="margin:16px;padding:14px 12px;border:1px solid #999;font-size:16px" value="Search">
<p style="margin:16px">Use <code style="background:#000;color:#fff">npmnpmnpm</code> here</p>
<div style="height:900px"></div>
<h2 style="position:sticky;top:0;margin:0;padding:8px 16px;background:#eee">Section B</h2>
<div style="height:900px"></div></body>`,
  );
  const src = { kind: "web", url: `file://${path.join(dir, "more.html")}` };
  const imp = await call(client, "import_ui", { filePath: file, source: src, name: "More" });
  assert.ok(!imp.isError, text(imp));
  const id = /"More" \((\S+)\)/.exec(text(imp))[1];
  const order = JSON.parse(/N (.*)/.exec(text(await call(client, "execute", { filePath: file, input: `Print("N", JSON.stringify(Get(${JSON.stringify(id)}, (n) => n.type === "text" || /code/i.test(n.name) ? n.name : undefined)))` })))[1]);
  assert.ok(order.findIndex((n) => /code/i.test(n)) < order.findIndex((n) => /^Use /.test(n)), `the code box comes before (under) the paragraph: ${order.join(" | ")}`);
  const v = await call(client, "verify", { filePath: file, target: id, source: src });
  assert.match(text(v), /Verdict: MATCH/, text(v).split("\n").filter((l) => /\[(high|medium)\]|Verdict/.test(l)).join("\n"));
  const lint = text(await call(client, "lint", { filePath: file, target: id, rules: ["covered"] }));
  assert.match(lint, /0 findings/);
});

test("import_ui: sizes on the one token with that value, and marked elements as instances of their component", async () => {
  await call(client, "execute", {
    filePath: file,
    input: `SetVariables({ r12: { type: "number", value: 12 }, "text-lg": { type: "number", value: 18 }, s18: { type: "number", value: 18 } });
pill = Insert(document, { type: "frame", name: "C/Pill", reusable: true, x: 0, y: -900, width: 80, height: 28, layout: "horizontal", justifyContent: "center", alignItems: "center", fill: "#2563EB", cornerRadius: 14 });
Insert(pill, { type: "text", name: "Label", content: "New", fill: "#FFFFFF", fontFamily: "Arial", fontSize: 13 });`,
  });
  fs.writeFileSync(
    path.join(dir, "tokens.html"),
    `<body style="margin:0;font-family:Arial;background:#fff">
<div style="margin:16px;padding:16px;border-radius:12px;background:#F3F4F6"><p style="margin:0;font-size:18px">Card title</p></div>
<div data-pen="C/Pill" style="margin:16px;width:80px;height:28px;border-radius:14px;background:#2563EB;color:#fff;font-size:13px;display:flex;align-items:center;justify-content:center"><span>Hot</span></div>
</body>`,
  );
  const res = await call(client, "import_ui", { filePath: file, source: { kind: "web", url: `file://${path.join(dir, "tokens.html")}` }, name: "Tokens" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /1 component instances/);
  const id = /"Tokens" \((\S+)\)/.exec(text(res))[1];
  const nodes = JSON.parse(/N (.*)/.exec(text(await call(client, "execute", { filePath: file, input: `Print("N", JSON.stringify(Get(${JSON.stringify(id)}, (c) => ({ type: c.type, name: c.name, cornerRadius: c.cornerRadius, ref: c.ref, descendants: c.descendants }))))` })))[1]);
  assert.ok(nodes.some((n) => n.cornerRadius === "$r12"), `radius 12 on its token: ${JSON.stringify(nodes)}`);
  const inst = nodes.find((n) => n.type === "ref");
  assert.ok(inst, "the marked element is an instance");
  assert.deepEqual(Object.values(inst.descendants ?? {}), [{ content: "Hot" }], "its text is an override");
  const texts = JSON.parse(/N (.*)/.exec(text(await call(client, "execute", { filePath: file, input: `Print("N", JSON.stringify(Get(${JSON.stringify(id)}, (n) => n.type === "text" ? [n.content, n.fontSize] : undefined)))` })))[1]);
  assert.ok(texts.some(([c, s]) => c === "Card title" && s === 18), "18 is shared by two tokens, so it stays a number");
});

test("import_ui builds auto layout where the engine reproduces the page (flexbox, even column stacks) and keeps the round trip a MATCH", async () => {
  fs.writeFileSync(
    path.join(dir, "flex.html"),
    `<body style="margin:0;font-family:Arial;background:#fff">
<header style="height:56px;background:#0F172A;color:#fff;display:flex;align-items:center;padding:0 16px"><h1 style="margin:0;font-size:20px">Profile</h1></header>
<main style="padding:16px;display:flex;flex-direction:column;gap:12px">
<div style="background:#F1F5F9;border-radius:12px;padding:16px"><p style="margin:0;font-size:16px">First</p><p style="margin:8px 0 0;font-size:14px">Second</p></div>
<button style="height:48px;border:0;border-radius:10px;background:#6366F1;color:#fff;font-size:16px">Go</button>
</main></body>`,
  );
  const src = { kind: "web", url: `file://${path.join(dir, "flex.html")}` };
  const res = await call(client, "import_ui", { filePath: file, source: src, name: "Flex" });
  assert.match(text(res), /Auto layout: [1-9]\d* containers are auto-layout frames/);
  const id = /"Flex" \((\S+)\)/.exec(text(res))[1];
  const frames = JSON.parse(/N (.*)/.exec(text(await call(client, "execute", { filePath: file, input: `Print("N", JSON.stringify(Get(${JSON.stringify(id)}, (n) => n.type === "frame" ? [n.name, n.layout, n.gap] : undefined)))` })))[1]);
  assert.ok(frames.some(([name, layout, gap]) => name === "main" && layout === "vertical" && gap === 12), JSON.stringify(frames));
  const v = await call(client, "verify", { filePath: file, target: id, source: src, crops: 0 });
  assert.match(text(v), /Verdict: MATCH/, text(v).split("\n").filter((l) => /\[(high|medium)\]/.test(l)).join("\n"));
});

test("stackLayout: even gaps make a column; uneven gaps or positioned children do not", async () => {
  const { stackLayout } = await import("../src/import/build.js");
  const box = (x, y, w, h) => ({ box: { x, y, w, h } });
  const parent = box(0, 0, 200, 100);
  assert.deepEqual(stackLayout(parent, [box(10, 10, 100, 20), box(10, 38, 100, 20), box(10, 66, 100, 20)]), { dir: "column", gap: 8, padding: [10, 90, 14, 10], align: "flex-start", justify: "flex-start", inferred: true });
  assert.equal(stackLayout(parent, [box(10, 10, 100, 20), box(10, 38, 100, 20), box(10, 70, 100, 20)]), null);
  assert.equal(stackLayout(parent, [box(10, 10, 100, 20), { ...box(10, 38, 100, 20), absolute: true }]), null);
});

test("import_ui points out repeated structures that are not components", async () => {
  fs.writeFileSync(path.join(dir, "list.html"), `<body style="margin:0;font-family:Arial">${["A", "B", "C"].map((t) => `<div style="margin:8px;height:40px;background:#EEE"><span>${t}</span></div>`).join("")}</body>`);
  const res = await call(client, "import_ui", { filePath: file, source: { kind: "web", url: `file://${path.join(dir, "list.html")}` }, name: "List" });
  assert.match(text(res), /Repeated like a component but not one: 3× "[^"]+"/);
});
