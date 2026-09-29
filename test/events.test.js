// Observability: events per call (no content), retention, the report, and a real server writing them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildEvent, readEvents, recordEvent, resultTokens } from "../src/events.js";
import { renderSummary, summarize } from "../src/report.js";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-events-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
// A 390×844 PNG header: 14 × 31 image tokens.
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from([0, 0, 1, 134, 0, 0, 3, 76]), Buffer.alloc(16)]).toString("base64");

test("resultTokens counts text and image tokens", () => {
  assert.deepEqual(resultTokens({ content: [{ type: "text", text: "abcdefgh" }, { type: "image", data: png }] }), { text: 2, image: 14 * 31 });
});

test("events hold measurements, never arguments or texts; Next: followed is judged on the next call", () => {
  const ctx = { tool: "verify", file: "/secret/path/app.pen", mode: "headless", marks: { call: 400 }, meta: { verify: { verdict: "differs", frame: "F1" }, next: { state: "differs", tool: "verify", target: "F1" } } };
  const e1 = buildEvent({ ctx, args: { target: "F1", source: { url: "http://secret" } }, res: { content: [{ type: "text", text: "File: x\nVerdict: DIFFERS\nNote: same findings" }] }, totalMs: 1234 });
  assert.equal(e1.file.split("#")[0], "app.pen");
  assert.ok(!JSON.stringify(e1).includes("secret"), "no paths or arguments");
  assert.equal(e1.notes, 1);
  assert.equal(e1.verify.verdict, "differs");
  const e2 = buildEvent({ ctx: { tool: "verify", meta: {} }, args: { target: "F1" }, res: { content: [] }, totalMs: 10 });
  assert.equal(e2.followedNext, true);
  const e3 = buildEvent({ ctx: { tool: "inspect", meta: {} }, args: {}, res: { isError: true, content: [{ type: "text", text: "File: x\nboom: it failed" }] }, totalMs: 5 });
  assert.equal(e3.followedNext, undefined, "no suggestion was pending");
  assert.equal(e3.error, "boom: it failed");
});

test("retention deletes files past 30 days; the report aggregates tools, runs until MATCH and Next followed", () => {
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, "events"), { recursive: true });
  fs.writeFileSync(path.join(home, "events", "2000-01-01.jsonl"), "{}\n");
  const now = Date.now();
  const at = (i) => new Date(now - (100 - i) * 1000).toISOString();
  const ev = (i, tool, ms, extra = {}) => recordEvent(home, { at: at(i), pid: 1, project: "shop#abc123", tool, file: "app.pen#aaaaaa", ms, ok: true, tokens: { text: 100, image: 0 }, ...extra });
  ev(0, "inspect", 400, { marks: { call: 300 } });
  ev(1, "verify", 5000, { verify: { verdict: "differs", frame: "F1", kinds: ["missing"] }, marks: { call: 1000 } });
  ev(2, "verify", 4000, { verify: { verdict: "match", frame: "F1", kinds: [] }, followedNext: true });
  ev(3, "verify", 6000, { verify: { verdict: "differs", frame: "F2", kinds: ["missing", "fill"] }, followedNext: false });
  ev(4, "inspect", 600, { ok: false, error: "no such node" });
  assert.ok(!fs.existsSync(path.join(home, "events", "2000-01-01.jsonl")), "old day deleted");
  const s = summarize(readEvents(home, { days: 1 }).events);
  assert.equal(s.calls, 5);
  const verify = s.tools.find((t) => t.tool === "verify");
  assert.equal(verify.p50, 5000);
  assert.deepEqual([s.verify.frames, s.verify.matched, s.verify.runsToMatch.median, s.verify.neverMatched], [2, 1, 2, 1]);
  assert.deepEqual(s.verify.findingKinds[0], ["missing", 2]);
  assert.deepEqual(s.next, { judged: 2, followed: 1 });
  const text = renderSummary(s, { days: 1 }).join("\n");
  assert.match(text, /verify \| 3 \| 0 \| 5\.0 s \| 6\.0 s/);
  assert.match(text, /inspect \| 2 \| 1 \(50%\) .* \| no such node/);
  assert.match(text, /2 frames verified; 1 reached MATCH after 2 run\(s\)/);
  assert.match(text, /Next: followed 50% \(1\/2/);
  const json = JSON.parse(execFileSync(process.execPath, [new URL("../bin/pen-multi.js", import.meta.url).pathname, "report", "--days", "1", "--json"], { env: { ...process.env, PEN_MULTI_HOME: home }, encoding: "utf8" }));
  assert.equal(json.calls, 5);
});

test("a real server writes one event per call; PEN_MULTI_EVENTS=0 writes none", async () => {
  for (const [name, env, expect] of [["on", {}, true], ["off", { PEN_MULTI_EVENTS: "0" }, false]]) {
    const home = path.join(dir, `srv-${name}`);
    const c = await connect({ home, cwd: dir, env: { PEN_MULTI_PREWARM: "0", ...env } });
    const res = await call(c, "execute", { filePath: path.join(dir, `${name}.pen`), input: `Insert(document, { type: "frame", name: "Home", width: 390, height: 844 })` });
    assert.ok(!res.isError, text(res));
    await c.close();
    const { events } = readEvents(home, { days: 1 });
    assert.equal(events.length === 1, expect, JSON.stringify(events));
    if (expect) assert.equal(events[0].tool, "execute");
  }
});
