// The real-app eval harness: seeded mutations on compared nodes, execute Copy/Move on the real
// engine, and a workspace that never writes into the source repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildModel } from "../src/design/model.js";
import { candidates, mutate, operation, rng } from "../bench/eval/real/mutate.mjs";
import { makeWorkspace, removeWorkspace, startApp } from "../bench/eval/real/workspace.mjs";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-realeval-")));
let client;
after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const node = (id, parent, b, props = {}) => ({ id, parent, depth: 0, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] }, ...props });

test("candidates target compared nodes; the same seed picks the same operations", () => {
  const m = buildModel({
    root: "S",
    nodes: [
      node("S", null, [0, 0, 390, 844], { type: "frame", name: "S", layout: "vertical", gap: 8 }),
      node("T", "S", [0, 0, 390, 24], { type: "text", name: "Title", content: "Hello", fill: "$ink" }),
      node("B", "S", [0, 32, 390, 48], { type: "frame", name: "Btn", fill: "$brand", cornerRadius: 8 }),
    ],
    refs: {},
    comps: {},
    variables: { ink: { type: "color", value: "#111" }, brand: { type: "color", value: "#25F" } },
  });
  const c = candidates(m, { ink: { type: "color", value: "#111" }, brand: { type: "color", value: "#25F" } });
  assert.deepEqual(c.text.map((x) => x.id), ["T"]);
  assert.deepEqual(c.radius, [{ id: "B", address: "S/Btn", from: 8, to: 14 }]);
  assert.deepEqual(c.color.find((x) => x.id === "B").choices, ["$ink"]);
  assert.deepEqual(c.order.map((x) => x.id), ["B"]);
  const a = rng(42), b = rng(42);
  assert.equal(a(), b());
  assert.match(operation("text", c.text[0], a).input, /^Update\("T", \{ content: "Hello \(new\)" \}\)$/);
});

test("mutations apply on the real engine (Update, Copy, Move) and are described", async () => {
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" } });
  const file = path.join(dir, "m.pen");
  const out = text(await call(client, "execute", { filePath: file, input: `SetVariables({ ink: { type: "color", value: "#111111" }, brand: { type: "color", value: "#2563EB" } });
s = Insert(document, { type: "frame", name: "Home", width: 390, height: 844, layout: "vertical", gap: 8, fill: "#FFFFFF" });
Insert(s, { type: "text", name: "Title", content: "Welcome", fill: "$ink", fontSize: 20 });
Insert(s, { type: "frame", name: "Card", width: 358, height: 60, fill: "$brand", cornerRadius: 8 });
Print("S", s);` }));
  const id = /S (\S+)/.exec(out)[1];
  const all = [];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const f = path.join(dir, `m${seed}.pen`);
    await call(client, "save", { filePath: file });
    fs.copyFileSync(file, f);
    all.push(...(await mutate(client, f, id, { seed, count: 2 })));
  }
  assert.ok(new Set(all.map((m) => m.kind)).size >= 4, `several kinds exercised: ${all.map((m) => m.kind).join(",")}`);
  for (const m of all) assert.ok(m.what.length > 5);
});

test("a workspace clones the committed state, links dependencies, moves the port, and leaves the repo untouched", async () => {
  const repo = path.join(dir, "app");
  fs.mkdirSync(path.join(repo, "web"), { recursive: true });
  fs.writeFileSync(path.join(repo, "web", "server.js"), `require("http").createServer((q, s) => s.end("ok")).listen(+process.argv[2], "127.0.0.1");`);
  fs.writeFileSync(path.join(repo, ".pen-multi.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:5173", routes: { Home: "/" } }));
  fs.writeFileSync(path.join(repo, "app.pen"), "x");
  fs.mkdirSync(path.join(repo, "deps"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, ".gitignore"), "deps/\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "uncommitted.txt"), "not in the clone");
  const before = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
  const app = { name: "t", repo, pen: "app.pen", app: { cwd: "web", start: `node server.js {port}` }, link: ["deps"], source: "web" };
  const ws = await makeWorkspace(app);
  try {
    assert.ok(!fs.existsSync(path.join(ws.dir, "uncommitted.txt")), "only the committed state");
    assert.ok(fs.lstatSync(path.join(ws.dir, "deps")).isSymbolicLink());
    assert.notEqual(ws.port, 5173);
    assert.match(fs.readFileSync(path.join(ws.dir, ".pen-multi.json"), "utf8"), new RegExp(`127\\.0\\.0\\.1:${ws.port}`));
    const stop = await startApp(ws);
    assert.equal(await (await fetch(`${ws.baseUrl}/`)).text(), "ok");
    stop();
  } finally {
    removeWorkspace(ws);
  }
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), before, "the repo is untouched");
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".pen-multi.json"), "utf8")).baseUrl, "http://127.0.0.1:5173");
});
