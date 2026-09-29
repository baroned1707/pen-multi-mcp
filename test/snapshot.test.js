// The snapshot contract, file and command sources, and command trust.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { validateSnapshot } from "../src/snapshot/schema.js";
import { isTrusted } from "../src/snapshot/trust.js";
import { captureCommand, captureFile } from "../src/verify/adapters/command.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-snapshot-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const home = path.join(dir, "home");
const good = { version: 1, platform: "flutter", viewport: { w: 390, h: 844 }, fields: ["text", "fg"], elements: [{ box: { x: 16, y: 20, w: 120, h: 24 }, text: "Hi", marker: "pen:Title", fg: "#111111" }] };

test("validateSnapshot: a minimal valid snapshot, and errors that name the path", () => {
  assert.deepEqual(validateSnapshot(good), []);
  const errs = validateSnapshot({ version: 2, viewport: { w: 0 }, elements: [{ box: { x: 1, y: 2, w: 3 } }, { text: 5, box: { x: 0, y: 0, w: 1, h: 1 } }], fields: ["color"] });
  assert.ok(errs.includes("snapshot.version: must be 1, got 2"));
  assert.ok(errs.some((e) => e.startsWith("snapshot.viewport.h: required")));
  assert.ok(errs.some((e) => e.startsWith("snapshot.viewport.w: must be > 0")));
  assert.ok(errs.some((e) => e.startsWith("snapshot.elements[0].box.h: required")));
  assert.ok(errs.includes("snapshot.elements[1].text: must be a string, got number"));
  assert.ok(errs.some((e) => e.startsWith("snapshot.fields[0]: must be one of text, bg")));
});

test("file source: reads and validates; a relative screenshot is next to the snapshot", () => {
  fs.writeFileSync(path.join(dir, "s.json"), JSON.stringify({ ...good, screenshot: "s.png" }));
  const { snapshot } = captureFile({ path: "s.json" }, { cwd: dir });
  assert.equal(snapshot.screenshot, path.join(dir, "s.png"));
  assert.deepEqual(snapshot.request, { kind: "file", path: "s.json" });
  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ version: 1, viewport: { w: 1, h: 1 } }));
  assert.throws(() => captureFile({ path: "bad.json" }, { cwd: dir }), /not a valid snapshot .*\n- snapshot.elements: required/s);
});

test("command source: refused until a person trusts it; then run with the capture's environment", async () => {
  const run = `node -e 'const fs=require("fs");fs.writeFileSync(process.env.PEN_SNAPSHOT_OUT, JSON.stringify({version:1,viewport:{w:+process.env.PEN_WIDTH,h:+process.env.PEN_HEIGHT},elements:[{box:{x:0,y:0,w:1,h:1},text:process.env.PEN_TARGET+"/"+process.env.PEN_THEME}]}))'`;
  const opts = { home, cwd: dir, width: 390, height: 844, theme: "dark", target: "Home", out: path.join(dir, "out", "cap") };
  await assert.rejects(captureCommand({ run }, opts), /off for untrusted commands.*\n {2}node ".*bin\/pen-multi\.js" trust /s);
  execFileSync(process.execPath, [new URL("../bin/pen-multi.js", import.meta.url).pathname, "trust", dir, run], { env: { ...process.env, PEN_MULTI_HOME: home } });
  assert.ok(isTrusted(home, path.join(dir, "sub"), run), "a trusted project covers its subfolders");
  assert.ok(!isTrusted(home, dir, `${run} `), "a different command is not trusted");
  const { snapshot } = await captureCommand({ run }, opts);
  assert.equal(snapshot.viewport.w, 390);
  assert.equal(snapshot.elements[0].text, "Home/dark");
  await assert.rejects(captureCommand({ run: "exit 3" }, { ...opts, cwd: dir, home: path.join(dir, "nohome") }).catch((e) => Promise.reject(e)), /untrusted/);
});
