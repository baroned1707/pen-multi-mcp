// Project context: the brief's digest, the stamp and what changed since, first-time attach, the
// canvas note, and doctor — on a temp git project with a real engine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { digestOf, sinceStamp, snapshotNow } from "../src/context/brief.js";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-context-")));
const file = path.join(dir, "app.pen");
const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8" });
let client;
after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("digestOf keeps headings and their first lines, bounded", () => {
  const text = ["# Brief", "Intro line", "more", "## Voice", "", "Plain Vietnamese", "detail", ...Array.from({ length: 60 }, (_, i) => `## S${i}\nline ${i}`)].join("\n");
  const d = digestOf(text, 10);
  assert.deepEqual(d.slice(0, 4), ["# Brief", "Intro line", "## Voice", "Plain Vietnamese"]);
  assert.equal(d.length, 11);
  assert.match(d.at(-1), /the full brief/);
});

test("sinceStamp: structural changes make the brief stale; commits and files alone do not", () => {
  const base = { at: "2026-09-30T00:00:00Z", commit: null, sources: { "CLAUDE.md": "a" }, routes: ["Home"], components: ["Button"], tokens: ["$ink"] };
  assert.equal(sinceStamp(base, { ...base }, dir).stale, false);
  const d = sinceStamp(base, { ...base, sources: { "CLAUDE.md": "b" }, routes: ["Home", "Alerts"], tokens: [] }, dir);
  assert.equal(d.stale, true);
  assert.deepEqual([d.sources, d.routes.added, d.tokens.removed], [["CLAUDE.md"], ["Alerts"], ["$ink"]]);
});

test("project_context end to end: no brief → write, stamp with a canvas note → the project changes → possibly out of date", async () => {
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Trading console\nFor one owner. Vietnamese UI.\n");
  fs.writeFileSync(path.join(dir, ".pen-multi.json"), JSON.stringify({ routes: { Home: "/" }, brief: { file: "design/BRIEF.md", sources: ["CLAUDE.md"] } }));
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" } });
  const first = text(await call(client, "execute", { filePath: file, input: `SetVariables({ ink: { type: "color", value: "#111111" } }); s = Insert(document, { type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF" }); Insert(s, { type: "text", name: "Title", content: "Hôm nay", fill: "$ink", fontSize: 20 });` }));
  assert.match(first, /## Project brief \(shown once per file; project_context for all of it\)\nNo brief at design\/BRIEF\.md/);
  await call(client, "save", { filePath: file });
  git("add", "-A");
  git("commit", "-q", "-m", "start");

  // The first design-tool call already brought the brief's status (none yet); later ones do not repeat it.
  const later = text(await call(client, "overview", { filePath: file }));
  assert.doesNotMatch(later, /## Project brief/, "shown once per file (the execute above got it)");
  const none = text(await call(client, "project_context", { filePath: file }));
  assert.match(none, /No brief at design\/BRIEF\.md/);
  assert.match(none, /Tokens \(1\): \$ink #111111/);

  fs.mkdirSync(path.join(dir, "design"));
  fs.writeFileSync(path.join(dir, "design", "BRIEF.md"), "# Brief\n## Product\nA calm trading console for one owner.\n## Language and voice\nVietnamese, short, no jargon.\n## Rules\nNever red for a normal drop.\n");
  const stamped = text(await call(client, "project_context", { filePath: file, action: "stamp" }));
  assert.match(stamped, /Stamped design\/BRIEF\.md against [0-9a-f]{7}: 1 source\(s\), 1 routes/);
  assert.match(stamped, /Canvas note "Project brief" added/);
  const note = text(await call(client, "execute", { filePath: file, input: `Print("N", JSON.stringify(Get((n, c) => { c.skipChildren(); return n.name === "Project brief" ? n.content : undefined; }).filter(Boolean)))` }));
  assert.match(note, /A calm trading console for one owner/);
  assert.match(text(await call(client, "project_context", { filePath: file })), /Since the brief \(\d{4}-\d{2}-\d{2}, [0-9a-f]{7}\): nothing structural changed/);

  // Development moves on: the source document, a new route, a new token, a new file, a commit.
  fs.appendFileSync(path.join(dir, "CLAUDE.md"), "Alerts now come by Telegram.\n");
  fs.writeFileSync(path.join(dir, ".pen-multi.json"), JSON.stringify({ routes: { Home: "/", Alerts: "/alerts" }, brief: { file: "design/BRIEF.md", sources: ["CLAUDE.md"] } }));
  await call(client, "execute", { filePath: file, input: `SetVariables({ warn: { type: "color", value: "#B45309" } })` });
  fs.writeFileSync(path.join(dir, "Alerts.tsx"), "export const Alerts = () => null;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Add alerts");
  const now = text(await call(client, "project_context", { filePath: file }));
  assert.match(now, /possibly out of date/);
  assert.match(now, /sources changed: CLAUDE\.md/);
  assert.match(now, /routes: added Alerts/);
  assert.match(now, /tokens: added \$warn/);
  assert.match(now, /1 commit\(s\): "Add alerts"/);
  assert.match(now, /files added Alerts\.tsx/);
  assert.match(now, /Next: the refresh-brief prompt/);
  const doctor = text(await call(client, "doctor", { filePath: file }));
  assert.match(doctor, /✅ Design brief design\/BRIEF\.md/);
});
