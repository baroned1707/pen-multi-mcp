// The port loop: queue logic, then end to end with the real engine, headless Chromium, a page
// that needs its API mocked to show each state, and .pen-multi.json routes and states.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { counts, nextItem, planQueue, recordVerify, settle } from "../src/port/queue.js";
import { mockPattern } from "../src/verify/adapters/web.js";
import { call, connect, text } from "./helpers.js";

test("queue: plan keeps progress, next resumes a claim, leases expire, attempts block, settle", () => {
  const cells = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
  let q = planQueue(null, cells, { maxAttempts: 2, now: 0 });
  let r = nextItem(q, "x", { now: 0 });
  assert.equal(r.item.id, "a");
  q = r.queue;
  assert.equal(nextItem(q, "x", { now: 1000 }).item.id, "a", "a claim resumes its own item");
  r = nextItem(q, "y", { now: 1000 });
  assert.equal(r.item.id, "b", "another claim gets the next item");
  q = r.queue;
  assert.equal(nextItem(q, "z", { now: 31 * 60_000 }).item.id, "a", "an expired lease is handed out again");
  q = recordVerify(q, "a", { verdict: "differs", high: 1, medium: 0 }, { now: 2000 }).queue;
  q = recordVerify(q, "a", { verdict: "differs", high: 1, medium: 0 }, { now: 3000 }).queue;
  r = nextItem(q, "x", { now: 4000 });
  assert.equal(q.items.find((i) => i.id === "a").attempts, 2);
  assert.equal(r.queue.items.find((i) => i.id === "a").status, "blocked", "out of attempts");
  assert.equal(r.item.id, "c");
  q = settle(r.queue, "b", "match").queue;
  const replanned = planQueue(q, cells, { maxAttempts: 2 });
  assert.equal(replanned.items.find((i) => i.id === "b").status, "match", "re-planning keeps progress");
  assert.deepEqual(counts(replanned), { todo: 0, "in-progress": 1, match: 1, blocked: 1, skipped: 0 });
});

test("queue: a filtered re-plan keeps the rest, drops deleted frames, keeps maxAttempts, reopens when raised", () => {
  let q = planQueue(null, [{ id: "a" }, { id: "b" }, { id: "c" }], { maxAttempts: 1, now: 0 });
  q = recordVerify(q, "a", { verdict: "differs", high: 1, medium: 0 }).queue;
  q = nextItem(q, "x").queue;
  assert.equal(q.items.find((i) => i.id === "a").status, "blocked");
  const filtered = planQueue(q, [{ id: "b" }], { frameIds: new Set(["a", "b"]) });
  assert.deepEqual(filtered.items.map((i) => i.id).sort(), ["a", "b"], "c was deleted from the design; a stays although filtered out");
  assert.equal(filtered.maxAttempts, 1, "maxAttempts is kept when not passed");
  assert.equal(filtered.items.find((i) => i.id === "a").status, "blocked");
  const raised = planQueue(filtered, [], { maxAttempts: 3 });
  assert.equal(raised.items.find((i) => i.id === "a").status, "todo", "raising maxAttempts reopens an item blocked for attempts");
  const manual = settle(raised, "b", "blocked", "needs an API").queue;
  assert.equal(planQueue(manual, [], { maxAttempts: 9 }).items.find((i) => i.id === "b").status, "blocked", "a manual block stays");
});

test("mock urls: /regex/flags without g or y, globs stay globs", () => {
  const re = mockPattern("/api\\/items/gi");
  assert.ok(re instanceof RegExp && re.flags === "i");
  assert.ok(re.test("http://x/API/items") && re.test("http://x/api/items"), "no lastIndex state between requests");
  assert.equal(mockPattern("**/api/items"), "**/api/items");
  assert.equal(mockPattern("/**/api/"), "/**/api/");
});

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-port-")));
const file = path.join(dir, "app.pen");
let client, server, base;
const ids = {};

before(async () => {
  // A page that shows a list or an empty message depending on its API; the API itself fails
  // (no backend), so every state has to be mocked.
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      res.writeHead(500);
      return res.end("no backend");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<body style="margin:0;font-family:Arial;background:#fff"><h1 style="margin:16px;font-size:24px">Items</h1><div id="list" style="margin:0 16px"></div>
<script>fetch("/api/items").then((r) => r.json()).then((items) => { document.getElementById("list").innerHTML = items.length ? items.map((i) => '<p style="margin:0 0 8px;font-size:16px">' + i + "</p>").join("") : '<p style="margin:0;font-size:16px;color:#888">No items</p>'; });</script></body>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" } });
  const withItems = [{ url: "**/api/items", json: ["Apple", "Pear"] }];
  const empty = [{ url: "**/api/items", json: [] }];
  // The design is imported from the page in each state, then named as a screen and its state.
  for (const [name, mocks] of [["Home", withItems], ["Home — empty", empty]]) {
    const res = await call(client, "import_ui", { filePath: file, source: { kind: "web", url: `${base}/`, mocks }, name });
    assert.ok(!res.isError, text(res));
    ids[name] = new RegExp(`"${name}" \\((\\S+)\\)`).exec(text(res))[1];
  }
  fs.writeFileSync(
    path.join(dir, ".pen-multi.json"),
    JSON.stringify({ baseUrl: base, routes: { Home: "/" }, states: { Home: { mocks: withItems }, "Home — empty": { route: "/", mocks: empty } } }),
  );
});

after(async () => {
  await client?.close();
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const port = (args) => call(client, "port", { filePath: file, ...args });

test("mocks put the page into each state for verify", async () => {
  const res = await call(client, "verify", { filePath: file, target: ids["Home — empty"], source: { kind: "web", url: `${base}/`, mocks: [{ url: "**/api/items", json: [] }] } });
  assert.match(text(res), /Verdict: MATCH/);
  const wrong = await call(client, "verify", { filePath: file, target: ids["Home — empty"], source: { kind: "web", url: `${base}/`, mocks: [{ url: "**/api/items", json: ["Apple"] }] } });
  assert.match(text(wrong), /Verdict: DIFFERS/);
  assert.match(text(wrong), /missing: text "No items"/);
});

test("the loop: plan, parallel claims, verify recorded, done refused until MATCH, status", async () => {
  const plan = await port({ action: "plan" });
  assert.match(text(plan), /Port queue: 2 frames \(2 todo/);
  assert.match(text(plan), /0 without a route, 0 states without a states entry/);

  // Claimed at the same time from one process: the queue lock still hands out distinct items.
  const [a, b] = (await Promise.all([port({ action: "next", claim: "agent-a" }), port({ action: "next", claim: "agent-b" })])).map(text);
  const idA = /\((\S+)\)/.exec(a)[1], idB = /\((\S+)\)/.exec(b)[1];
  assert.notEqual(idA, idB, "parallel claims get different screens");
  assert.match(a + b, /State "Home — empty" from \.pen-multi\.json/);

  const refused = await port({ action: "done", id: ids["Home — empty"] });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /has not been verified yet|latest verify DIFFERS/, "no MATCH yet (the mocks test left a DIFFERS run)");
  const never = await port({ action: "done", id: ids.Home });
  assert.match(text(never), /has not been verified yet/);

  // Wrong state first: DIFFERS is recorded and done is refused.
  await call(client, "verify", { filePath: file, target: ids["Home — empty"], source: { kind: "web", mocks: [{ url: "**/api/items", json: ["Apple"] }] } });
  const notYet = await port({ action: "done", id: ids["Home — empty"] });
  assert.match(text(notYet), /latest verify DIFFERS/);

  // The states entry (route + mocks) makes it match; so does Home with its own state.
  for (const id of [ids["Home — empty"], ids.Home]) {
    const v = await call(client, "verify", { filePath: file, target: id, source: { kind: "web" } });
    assert.match(text(v), /Verdict: MATCH/, text(v).split("\n").filter((l) => /\[(high|medium)\]/.test(l)).join("\n"));
    assert.match(text(v), /state "Home(?: — empty)?" from \.pen-multi\.json/);
    const done = await port({ action: "done", id });
    assert.ok(!done.isError, text(done));
  }
  const status = text(await port({ action: "status" }));
  assert.match(status, /2 match, 0 in progress, 0 todo/);
  assert.match(status, /Home — empty \(\S+\) \| match \| 2 \| match/);
  assert.match(text(await port({ action: "next", claim: "agent-a" })), /The port is complete/);
});

test("done is refused when the design changed after the last verify", async () => {
  await call(client, "execute", { filePath: file, input: `Update(${JSON.stringify(ids.Home)}, { fill: "#FAFAFA" })` });
  await call(client, "save", { filePath: file });
  const res = await port({ action: "done", id: ids.Home });
  assert.equal(res.isError, true);
  assert.match(text(res), /verified against an older version of the design/);
});
