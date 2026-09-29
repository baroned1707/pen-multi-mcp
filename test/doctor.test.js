// doctor on a prepared project: each check, its fix, and nothing changed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-doctor-")));
const file = path.join(dir, "app.pen");
let client;
after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor reports what is missing for design ↔ code work, with fixes, and changes nothing", async () => {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" } });
  const out = text(await call(client, "execute", {
    filePath: file,
    input: `b = Insert(document, { type: "frame", name: "C/Button", reusable: true, x: 0, y: -300, width: 120, height: 40, fill: "#2563EB" });
p = Insert(document, { type: "frame", name: "C/Pill", reusable: true, x: 200, y: -300, width: 60, height: 24, fill: "#EEEEEE" });
h = Insert(document, { type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF" });
Insert(h, { type: "ref", ref: b, name: "Go" }); Insert(h, { type: "ref", ref: p, name: "Tag" });
Insert(document, { type: "frame", name: "Settings", x: 500, y: 0, width: 390, height: 844, fill: "#FFFFFF" });
Print("B", b);`,
  }));
  const buttonId = /B (\S+)/.exec(out)[1];
  await call(client, "save", { filePath: file });
  fs.mkdirSync(path.join(dir, "web"));
  fs.writeFileSync(path.join(dir, "web", "Button.tsx"), `export function Button() {\n  return <button data-pen="${buttonId}" />;\n}\n`);
  fs.writeFileSync(path.join(dir, "index.html"), "<p>home</p>");
  fs.writeFileSync(path.join(dir, ".pen-multi.json"), JSON.stringify({ baseUrl: `file://${dir}/`, routes: { Home: "index.html", Settings: "missing.html" }, tokens: { file: "web/tokens.css" } }));
  fs.writeFileSync(path.join(dir, ".gitignore"), "design-sync/\n");
  const before = fs.readdirSync(dir).sort();
  const t = text(await call(client, "doctor", { filePath: file }));
  assert.match(t, /✅ .* is a git repository\./);
  assert.match(t, /✅ Routes for 2 of 2 screens\./);
  assert.match(t, /✅ file:\/\/.*index\.html answers\./);
  assert.match(t, /❌ file:\/\/.*missing\.html: missing file\. Start the dev server/);
  assert.match(t, /⚠️ 1 of 2 components in use map to code\. Not mapped .*C\/Pill ×1/);
  assert.match(t, /❌ \.pen-multi\.json tokens\.file web\/tokens\.css does not exist\./);
  assert.match(t, /❌ design-sync\/ is gitignored: sync records must be committed/);
  assert.match(t, /Next: fix the ❌ items \(3\), then run doctor again\./);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "doctor changes nothing");
});
