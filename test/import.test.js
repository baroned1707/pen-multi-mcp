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
