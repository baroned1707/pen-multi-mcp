import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { call, connect, countNodes, rect, text } from "./helpers.js";

// Each "agent" is its own server process with its own project directory as cwd,
// which is how separate Claude Code sessions run it.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-agents-")));
const home = path.join(root, "home");
const project = (name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const clients = [];
const agent = async (opts) => {
  const c = await connect({ home, ...opts });
  clients.push(c);
  return c;
};
const utilityEditors = (serverPid) => {
  try {
    return execFileSync("pgrep", ["-f", `pen-multi-utility-${serverPid}.pen`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

after(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

test("three agents on three projects work at the same time, each on its own file", async () => {
  const names = ["shop", "blog", "admin"];
  const agents = await Promise.all(names.map((n) => agent({ cwd: project(n) })));

  // Every agent uses the same relative path; each must land in its own project.
  const results = await Promise.all(
    agents.map((a, i) => call(a, "execute", { filePath: "design.pen", input: rect(`from-${names[i]}`) })),
  );
  results.forEach((r) => assert.ok(!r.isError, text(r)));

  const counts = await Promise.all(agents.map((a) => call(a, "execute", { filePath: "design.pen", input: countNodes })));
  counts.forEach((r, i) => {
    assert.ok(text(r).startsWith(`File: ${path.join(root, names[i], "design.pen")}`), text(r).slice(0, 200));
    assert.match(text(r), new RegExp(`COUNT 1 \\["from-${names[i]}"\\]`));
  });

  const list = JSON.parse(text(await call(agents[0], "list_sessions", {})).replace(/^File:.*\n\n/, ""));
  assert.equal(list.sessions.length, 1);
  assert.equal(list.machineWide.length, 3, JSON.stringify(list.machineWide));
  assert.deepEqual(list.machineWide.map((h) => path.basename(h.agentProject)).sort(), [...names].sort());

  await Promise.all(agents.map((a) => call(a, "close_file", { filePath: "design.pen" })));
});

test("the machine-wide limit makes a new agent wait, then report who holds the slots", async () => {
  const env = { PEN_MULTI_GLOBAL_MAX_SESSIONS: "1", PEN_MULTI_WAIT_FOR_SLOT_SECONDS: "2" };
  const isolatedHome = path.join(root, "home-limit"); // only these two agents count toward the limit
  const first = await agent({ cwd: project("first"), env, home: isolatedHome });
  const second = await agent({ cwd: project("second"), env, home: isolatedHome });

  const held = await call(first, "execute", { filePath: "x.pen", input: 'Print("x")' });
  assert.ok(!held.isError, text(held));
  const blocked = await call(second, "execute", { filePath: "y.pen", input: 'Print("y")' });
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /No free pen editor slot/);
  assert.match(text(blocked), /agent in .*first/, "names the project holding the slot");

  // Once the first agent frees its slot, the second one gets in.
  await call(first, "close_file", { filePath: "x.pen" });
  const retry = await call(second, "execute", { filePath: "y.pen", input: 'Print("y-ran")' });
  assert.ok(!retry.isError, text(retry));
  await call(second, "close_file", { filePath: "y.pen" });
});

test("agents share one read_skill cache and do not each start an editor for it", async () => {
  const warm = await agent({ cwd: project("warm") });
  assert.ok(!(await call(warm, "read_skill", {})).isError);
  assert.equal(utilityEditors(warm.pid).length, 0, "the throwaway editor is closed after answering");

  const cold = await agent({ cwd: project("cold") });
  const started = Date.now();
  const res = await call(cold, "read_skill", {});
  assert.ok(!res.isError, text(res));
  assert.equal(utilityEditors(cold.pid).length, 0);
  assert.ok(Date.now() - started < 1000, `served from the shared cache (${Date.now() - started}ms)`);
});

test("an agent that dies does not block others from its files", async () => {
  const doomed = await agent({ cwd: project("doomed") });
  const file = path.join(root, "doomed", "d.pen");
  assert.ok(!(await call(doomed, "execute", { filePath: file, input: rect("before-crash") })).isError);
  assert.ok(!(await call(doomed, "save", { filePath: file })).isError, "saved before the crash");
  process.kill(doomed.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 1500));

  const rescuer = await agent({ cwd: project("rescuer") });
  const res = await call(rescuer, "execute", { filePath: file, input: countNodes });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /COUNT 1 \["before-crash"\]/, "autosaved work survives the crash");
});
