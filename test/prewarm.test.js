// Pre-warm against the fake CLI: the project's file is started ahead of use, adopted by the first
// call, and never blocks or outlives its welcome.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { prewarmCandidates } from "../src/prewarm.js";
import { call, connect, text } from "./helpers.js";

const fakeCli = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-prewarm-")));
const clients = [];
let n = 0;

/** A project directory with the given .pen files, its own pen-multi home and spawn log. */
function project(files = ["app.pen"]) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(dir);
  for (const f of files) fs.writeFileSync(path.join(dir, f), "doc");
  return { dir, home: path.join(dir, ".home"), log: path.join(dir, "spawns.log") };
}
const spawns = (p) => (fs.existsSync(p.log) ? fs.readFileSync(p.log, "utf8").trim().split("\n").filter(Boolean) : []);
async function server(p, env = {}, home = p.home) {
  const c = await connect({
    home,
    cwd: p.dir,
    env: { PEN_CLI_PATH: fakeCli, FAKE_SPAWN_LOG: p.log, PEN_MULTI_PREWARM_DELAY_MS: "0", ...env },
  });
  clients.push(c);
  return c;
}
const sessions = async (c) => JSON.parse(text(await call(c, "list_sessions", {})));
async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const outcome = async (c, name) => {
  const results = (await sessions(c)).prewarm;
  return Object.entries(results).find(([f]) => path.basename(f) === name)?.[1];
};
const warmIn = async (c) => (await sessions(c)).sessions.filter((s) => s.state === "warm" || s.state === "starting").map((s) => path.basename(s.filePath));

after(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the project's only .pen is pre-warmed and the first call adopts that editor", async () => {
  const p = project();
  const c = await server(p, { FAKE_STARTUP_MS: "600" });
  await until(async () => (await sessions(c)).sessions.some((s) => s.state === "starting")); // not "warm" before it is ready
  await until(async () => (await sessions(c)).sessions.some((s) => s.state === "warm"), 10_000);
  const res = await call(c, "execute", { filePath: "app.pen", input: "hello" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /ECHO .*app\.pen execute/);
  assert.equal(spawns(p).length, 1, "no second editor was started");
  const list = await sessions(c);
  assert.deepEqual(list.sessions.map((s) => s.state), ["open"]);
  assert.ok(!list.machineWide.some((h) => h.state === "warm"), "the warm marker was released on adoption");
});

test("a file changed on disk since it was pre-warmed is reopened, not served stale", async () => {
  const p = project();
  const c = await server(p);
  await until(async () => (await warmIn(c)).length === 1);
  fs.writeFileSync(path.join(p.dir, "app.pen"), "changed by another agent");
  const res = await call(c, "execute", { filePath: "app.pen", input: "x" });
  assert.ok(!res.isError, text(res));
  assert.equal(spawns(p).length, 2);
});

test("a pre-warmed editor never blocks another agent, and only one process pre-warms a file", async () => {
  const p = project();
  const a = await server(p);
  await until(async () => (await warmIn(a)).length === 1);
  const b = await server(p);
  await until(async () => (await outcome(b, "app.pen")) === "skipped: another agent pre-warmed it");
  assert.deepEqual(await warmIn(b), []);
  assert.equal(spawns(p).length, 1);

  const res = await call(b, "execute", { filePath: "app.pen", input: "b edits" });
  assert.ok(!res.isError, text(res));

  // a's first call now finds the file locked by b: the usual error, and a's warm editor is gone.
  const blocked = await call(a, "execute", { filePath: "app.pen", input: "a edits" });
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /being edited by another agent/);
  assert.deepEqual(await warmIn(a), []);
});

test("a file locked by another agent is not pre-warmed", async () => {
  const p = project();
  const a = await server(p, { PEN_MULTI_PREWARM: "0" });
  assert.ok(!(await call(a, "execute", { filePath: "app.pen", input: "a" })).isError);
  const b = await server(p);
  await until(async () => (await outcome(b, "app.pen")) === "skipped: another agent has it open");
  assert.deepEqual(await warmIn(b), []);
  assert.equal(spawns(p).length, 1);
});

test("a warm editor counts toward the machine limit and gives its slot up first", async () => {
  const p = project(["app.pen", "other.pen"]);
  fs.writeFileSync(path.join(p.dir, ".pen-multi.json"), JSON.stringify({ prewarm: ["app.pen"] }));
  const c = await server(p, { PEN_MULTI_GLOBAL_MAX_SESSIONS: "1", PEN_MULTI_WAIT_FOR_SLOT_SECONDS: "5" });
  await until(async () => (await warmIn(c)).length === 1);
  const res = await call(c, "execute", { filePath: "other.pen", input: "x" });
  assert.ok(!res.isError, text(res));
  assert.deepEqual(await warmIn(c), []);
  assert.deepEqual((await sessions(c)).sessions.map((s) => path.basename(s.filePath)), ["other.pen"]);
});

test("an unused warm editor closes after its time is up", async () => {
  const p = project();
  const c = await server(p, { PEN_MULTI_PREWARM_MINUTES: "0.01" }); // 0.6 s
  await until(async () => (await warmIn(c)).length === 1);
  await until(async () => (await warmIn(c)).length === 0, 5000);
  assert.ok(!(await sessions(c)).machineWide.some((h) => h.state === "warm"));
});

test("PEN_MULTI_PREWARM=0 turns pre-warm off", async () => {
  const p = project();
  const c = await server(p, { PEN_MULTI_PREWARM: "0" });
  await until(async () => (await outcome(c, "app.pen")) === "off");
  assert.deepEqual(await warmIn(c), []);
  assert.equal(spawns(p).length, 0);
});

test("a call arriving while the warm editor is still starting waits for it instead of starting another", async () => {
  const p = project();
  const c = await server(p, { FAKE_STARTUP_MS: "1500" });
  await until(async () => (await sessions(c)).sessions.some((s) => s.state === "starting"));
  const res = await call(c, "execute", { filePath: "app.pen", input: "early" });
  assert.ok(!res.isError, text(res));
  assert.equal(spawns(p).length, 1);
});

test("pre-warm stays within the per-agent limit", async () => {
  const p = project(["a.pen", "b.pen", "c.pen"]);
  fs.writeFileSync(path.join(p.dir, ".pen-multi.json"), JSON.stringify({ prewarm: ["a.pen", "b.pen", "c.pen"] }));
  const c = await server(p, { PEN_MULTI_MAX_SESSIONS: "2" });
  await until(async () => (await outcome(c, "c.pen")) !== undefined);
  assert.equal((await warmIn(c)).length, 2);
  assert.equal(await outcome(c, "c.pen"), "skipped: no free editor slot");
});

test("an agent short of slots reclaims another agent's unused warm editor", async () => {
  const home = path.join(root, "shared-home");
  const pa = project(["a.pen"]);
  const pb = project(["b.pen"]);
  const env = { PEN_MULTI_GLOBAL_MAX_SESSIONS: "1", PEN_MULTI_WAIT_FOR_SLOT_SECONDS: "10" };
  const a = await server(pa, env, home);
  await until(async () => (await warmIn(a)).length === 1);
  const b = await server(pb, { ...env, PEN_MULTI_PREWARM: "0" }, home);
  const started = Date.now();
  const res = await call(b, "execute", { filePath: "b.pen", input: "x" });
  assert.ok(!res.isError, text(res));
  assert.ok(Date.now() - started < 5000, "b did not wait for a's warm editor to expire");
  await until(async () => (await warmIn(a)).length === 0, 5000); // a stopped its editor
});

test("a file saved by another agent while the adopting call waited for a slot is reloaded", async () => {
  const p = project(["app.pen", "other.pen"]);
  fs.writeFileSync(path.join(p.dir, ".pen-multi.json"), JSON.stringify({ prewarm: ["app.pen"] }));
  const c = await server(p, { PEN_MULTI_MAX_SESSIONS: "1" });
  await until(async () => (await sessions(c)).sessions.some((s) => s.state === "warm"));
  const busy = call(c, "execute", { filePath: "other.pen", input: "SLOW:1500" }); // holds the only slot
  await until(async () => spawns(p).length === 2);
  const adopting = call(c, "execute", { filePath: "app.pen", input: "y" }); // waits for the slot
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(p.dir, "app.pen"), "saved by another agent meanwhile");
  assert.ok(!(await busy).isError);
  const res = await adopting;
  assert.ok(!res.isError, text(res));
  assert.equal(spawns(p).length, 3, "app.pen was reloaded, not served from the stale warm editor");
});

test("candidates: a .pen-multi.json list wins, else the only .pen, else nothing", () => {
  const one = project(["a.pen"]);
  assert.deepEqual(prewarmCandidates(one.dir), [path.join(one.dir, "a.pen")]);
  const two = project(["a.pen", "b.pen"]);
  assert.deepEqual(prewarmCandidates(two.dir), []);
  fs.writeFileSync(path.join(two.dir, ".pen-multi.json"), JSON.stringify({ prewarm: ["design/b.pen"] }));
  assert.deepEqual(prewarmCandidates(two.dir), [path.join(two.dir, "design/b.pen")]);
  assert.deepEqual(prewarmCandidates(path.join(root, "missing")), []);
});
