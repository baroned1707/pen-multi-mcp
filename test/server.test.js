import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { call, connect, countNodes, rect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-test-")));
const home = path.join(dir, "home");
const fileA = path.join(dir, "a.pen");
const fileB = path.join(dir, "b.pen");

let client;
before(async () => {
  client = await connect({ home });
});
after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("edits two files in parallel without mixing them up, and autosaves", async () => {
  const [ra, rb] = await Promise.all([
    call(client, "execute", { filePath: fileA, input: rect("OnlyInA") }),
    call(client, "execute", { filePath: fileB, input: rect("OnlyInB") + "\n" + rect("AlsoInB") }),
  ]);
  assert.ok(!ra.isError, text(ra));
  assert.ok(!rb.isError, text(rb));

  const [ca, cb] = await Promise.all([
    call(client, "execute", { filePath: fileA, input: countNodes }),
    call(client, "execute", { filePath: fileB, input: countNodes }),
  ]);
  assert.match(text(ca), /COUNT 1 \["OnlyInA"\]/);
  assert.match(text(cb), /COUNT 2 \["OnlyInB","AlsoInB"\]/);
  await Promise.all([fileA, fileB].map((filePath) => call(client, "save", { filePath })));
  assert.ok(fs.statSync(fileA).size > 0, "a.pen written to disk");
  assert.ok(fs.statSync(fileB).size > 0, "b.pen written to disk");
});

test("fork_version copies a file and the copy evolves independently", async () => {
  const v2 = path.join(dir, "a-v2.pen");
  const fork = await call(client, "fork_version", { filePath: fileA, newPath: v2 });
  assert.ok(!fork.isError, text(fork));

  await call(client, "execute", { filePath: v2, input: rect("OnlyInV2") });
  assert.match(text(await call(client, "execute", { filePath: v2, input: countNodes })), /COUNT 2/);
  assert.match(text(await call(client, "execute", { filePath: fileA, input: countNodes })), /COUNT 1 /);
});

test("a failed snippet is reported and can be patched with edits", async () => {
  const bad = await call(client, "execute", { filePath: fileA, input: "Print(Get(" });
  assert.equal(bad.isError, true);
  const editId = /editId`?: "(\w+)"/.exec(text(bad))?.[1];
  assert.ok(editId, `editId in: ${text(bad)}`);

  const fixed = await call(client, "execute", {
    filePath: fileA,
    editId,
    edits: [{ find: "Print(Get(", replace: 'Print("patched")' }],
  });
  assert.ok(!fixed.isError, text(fixed));
  assert.match(text(fixed), /patched/);
});

test("screenshots come back as image content", async () => {
  const res = await call(client, "execute", {
    filePath: fileA,
    input: `Get((n,c)=>{if(!c.parentCtx&&n.name==="OnlyInA")TakeScreenshot([n.id])})`,
  });
  assert.ok(!res.isError, text(res));
  const image = res.content.find((c) => c.type === "image");
  assert.ok(image, text(res));
  assert.equal(image.mimeType, "image/png");
  assert.doesNotMatch(text(res), /iVBOR/);
});

test("a second server cannot open a file another server holds", async () => {
  const other = await connect({ home, cwd: os.homedir() });
  try {
    const res = await call(other, "get_app_state", { filePath: fileA });
    assert.equal(res.isError, true);
    assert.match(text(res), /being edited by another agent/);
    assert.match(text(res), new RegExp(`agent in ${process.cwd()}`), "names the holding agent's project");
  } finally {
    await other.close();
  }
});

test("rejects non-.pen paths", async () => {
  assert.equal((await call(client, "get_app_state", { filePath: path.join(dir, "a.txt") })).isError, true);
});

test("every file response names the file it acted on", async () => {
  const res = await call(client, "get_app_state", { filePath: fileA });
  assert.ok(text(res).startsWith(`File: ${fileA}`), text(res).slice(0, 200));
});

test("read_skill works without any design file open", async () => {
  const fresh = await connect({ home });
  try {
    const res = await call(fresh, "read_skill", { path: "execute.md" });
    assert.ok(!res.isError, text(res));
    assert.match(text(res), /Insert/);
  } finally {
    await fresh.close();
  }
});

test("close_file frees the session", async () => {
  const res = await call(client, "close_file", { filePath: fileB });
  assert.match(text(res), /Closed/);
  const list = JSON.parse(text(await call(client, "list_sessions", {})));
  assert.ok(!list.sessions.some((s) => s.filePath === fileB));
});

test("a symlinked path maps to the same session as its real path", async () => {
  const link = path.join(os.tmpdir(), `pen-multi-link-${process.pid}`);
  fs.symlinkSync(dir, link);
  try {
    const res = await call(client, "execute", { filePath: path.join(link, "a.pen"), input: countNodes });
    assert.ok(!res.isError, text(res));
    const list = JSON.parse(text(await call(client, "list_sessions", {})));
    const aSessions = list.sessions.filter((s) => path.basename(s.filePath) === "a.pen");
    assert.equal(aSessions.length, 1, JSON.stringify(list.sessions));
  } finally {
    fs.unlinkSync(link);
  }
});

test("the real engine's silent and failing reads get concrete hints", async () => {
  const silent = await call(client, "execute", { filePath: fileA, input: "Get(n => n.name).length" });
  assert.match(text(silent), /HINT: Nothing was printed/);
  const cons = await call(client, "execute", { filePath: fileA, input: "console.log(1)" });
  assert.match(text(cons), /HINT: .*Print/);
  const awaited = await call(client, "execute", { filePath: fileA, input: 'const x = await Get("zz"); Print(x)' });
  assert.match(text(awaited), /HINT: .*synchronous/);
  const shot = await call(client, "execute", { filePath: fileA, input: 'TakeScreenshot("zz")' });
  assert.match(text(shot), /HINT: .*array/);
  const read = await call(client, "execute", { filePath: fileA, input: 'Print("hello")' });
  assert.doesNotMatch(text(read), /HINT|Saving to disk/);
});

test("a server whose host dies without closing stdin exits and releases its locks", async () => {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-orphan-"));
  // A host process that starts pen-multi with stdin held open by a grandchild, then is killed.
  const serverPath = new URL("../src/index.js", import.meta.url).pathname;
  const host = spawn(process.execPath, ["-e", `
    const { spawn } = require("child_process");
    const s = spawn(process.execPath, [${JSON.stringify(serverPath)}], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, PEN_MULTI_HOME: ${JSON.stringify(home)}, PEN_MULTI_APP: "0", PEN_MULTI_PREWARM: "0" } });
    // A keeper holds the write end of the server's stdin, so stdin never closes when the host dies.
    const keeper = spawn("sleep", ["30"], { stdio: ["ignore", s.stdin, "ignore"], detached: true });
    keeper.unref();
    console.log(s.pid + " " + keeper.pid);
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  const [serverPid, keeperPid] = (await new Promise((r) => host.stdout.once("data", (d) => r(String(d).trim())))).split(" ").map(Number);
  await new Promise((r) => setTimeout(r, 1500));
  host.kill("SIGKILL");
  const alive = () => {
    try {
      process.kill(serverPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const end = Date.now() + 15_000;
  while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
  const survived = alive();
  try {
    process.kill(keeperPid, "SIGKILL");
  } catch {}
  if (survived) process.kill(serverPid, "SIGKILL");
  assert.equal(survived, false, "the orphaned server exited");
  fs.rmSync(home, { recursive: true, force: true });
});
