// Sync records and diffs: what changed on each side since the last MATCH.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildRecord, codeFilesChanged, diffText, factsDiff, readRecord, recordPath, syncState, writeRecord } from "../src/sync/index.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-sync-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

const design = (title = "Welcome", fill = "#2563EB") => ({
  nodes: [
    { id: "t", address: "Home/Title", kind: "text", box: { x: 16, y: 20, w: 120, h: 24 }, text: title, color: "#111111", fontSize: 20, fontWeight: 700 },
    { id: "b", address: "Home/Button", kind: "box", box: { x: 16, y: 80, w: 358, h: 48 }, fill, radius: 10 },
  ],
});
const els = (text = "Welcome", bg = "rgb(37, 99, 235)") => [
  ["t", { i: 1, box: { x: 16, y: 20.4, w: 121, h: 23 }, text, fg: "rgb(17, 17, 17)", fontSize: 20, fontWeight: 700 }],
  ["b", { i: 2, box: { x: 16, y: 80, w: 358, h: 48 }, bg, radius: 10 }],
];

test("a record keeps design facts in clear and UI texts only as hashes", () => {
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c0");
  const rec = buildRecord({ penFile: path.join(dir, "app.pen"), penSha: "abc", frame: { id: "F", name: "Home", width: 390, theme: "light" }, design: design(), pairs: els("jane@example.com"), fields: ["text", "bg"], source: { kind: "web", url: "http://x/" }, root: dir });
  assert.equal(rec.nodes["Home/Title"].design.text, "Welcome");
  assert.match(rec.nodes["Home/Title"].ui.text, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(rec).includes("jane@example.com"), "no UI text in the record");
  assert.equal(rec.code.commit.length, 40);
  const file = recordPath(path.join(dir, "app.pen"), { id: "F", name: "Home", width: 390, theme: "light" });
  assert.match(path.relative(dir, file), /^design-sync\/Home-390-light-[0-9a-f]{6}\.json$/);
  writeRecord(file, rec);
  assert.deepEqual(readRecord(file), rec);
});

test("diffs: design changes by address with values; UI changes within tolerance are none, texts only as 'changed'", () => {
  const base = buildRecord({ penFile: "/p/app.pen", penSha: "a", frame: { id: "F", name: "Home" }, design: design(), pairs: els(), root: dir });
  const redesign = buildRecord({ penFile: "/p/app.pen", penSha: "b", frame: { id: "F", name: "Home" }, design: design("Hello", "#059669"), pairs: els(), root: dir });
  const d = factsDiff(base.nodes, redesign.nodes, "design");
  assert.deepEqual(d.changed.map((c) => [c.address, c.prop, c.to]), [["Home/Button", "fill", "#059669"], ["Home/Title", "text", "Hello"]]);
  const jitter = buildRecord({ penFile: "/p/app.pen", penSha: "a", frame: { id: "F", name: "Home" }, design: design(), pairs: [["t", { ...els()[0][1], box: { x: 17, y: 21, w: 120, h: 24 } }], els()[1]], root: dir });
  assert.deepEqual(factsDiff(base.nodes, jitter.nodes, "ui").changed, [], "1px of capture noise is not a change");
  const recode = buildRecord({ penFile: "/p/app.pen", penSha: "a", frame: { id: "F", name: "Home" }, design: design(), pairs: els("Welcome back", "rgb(5, 150, 105)"), root: dir });
  const u = factsDiff(base.nodes, recode.nodes, "ui");
  assert.deepEqual(u.changed.map((c) => [c.address, c.prop]), [["Home/Button", "bg"], ["Home/Title", "text (changed)"]]);
  assert.match(diffText(u), /~ Home\/Button bg "#2563EB" → "#059669"; ~ Home\/Title text \(changed\)/);
});

test("code files changed since the record's commit, working tree included; unknown commit is null", () => {
  fs.writeFileSync(path.join(dir, "Home.tsx"), "a");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c1");
  const rec = { code: { commit: git("rev-parse", "HEAD").trim() } };
  assert.deepEqual(codeFilesChanged(rec, ["Home.tsx"], dir), []);
  fs.writeFileSync(path.join(dir, "Home.tsx"), "b");
  assert.deepEqual(codeFilesChanged(rec, ["Home.tsx"], dir), ["Home.tsx"]);
  assert.equal(codeFilesChanged({ code: { commit: "0".repeat(40) } }, ["Home.tsx"], dir), null);
});

test("syncState", () => {
  assert.equal(syncState({ record: null }), "never");
  assert.equal(syncState({ record: null, lastVerdict: "differs" }), "differs");
  assert.equal(syncState({ record: {}, designChanged: true, codeChanged: true }), "both-changed");
  assert.equal(syncState({ record: {}, codeChanged: true }), "code-changed");
  assert.equal(syncState({ record: {} }), "in-sync");
});
