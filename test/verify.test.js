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
const report = () => JSON.parse(fs.readFileSync(path.join(dir, "design-verify", "checkout-light.json"), "utf8"));
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
  const snap = path.join(dir, "design-verify", "captures", "checkout-light.json");
  const again = await verify({ snapshot: snap });
  assert.match(text(again), /3 high, 5 medium/);
  fs.copyFileSync(path.join(dir, "design-verify", "captures", "checkout-light.png"), path.join(dir, "shot.png"));
  const img = await verify({ source: { kind: "image", path: "shot.png", width: 390 } });
  assert.match(text(img), /score n\/a \(image only\)/);
  assert.match(text(img), /pixels differ in .* — design there: Checkout · light\/Tab bar/);
});

test("contact_sheet draws a row per report and returns the image inline", async () => {
  const res = await call(client, "contact_sheet", { reports: ["design-verify/checkout-light.json"], savePath: "sheet.png" });
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
