// Pool and shell behaviour against a fake CLI: deterministic timing, runs in seconds.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, connect, text } from "./helpers.js";

const fakeCli = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-pool-")));
const clients = [];
const server = async (env) => {
  const c = await connect({ home: path.join(root, "home"), cwd: root, env: { PEN_CLI_PATH: fakeCli, ...env } });
  clients.push(c);
  return c;
};

after(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a file is never evicted between being opened and being used", async () => {
  const s = await server({ FAKE_STARTUP_MS: "1500", PEN_MULTI_MAX_SESSIONS: "1" });

  // b.pen arrives while a.pen's editor is still starting, with only one slot available.
  const first = call(s, "execute", { filePath: "a.pen", input: "one" });
  await new Promise((r) => setTimeout(r, 300));
  const second = call(s, "execute", { filePath: "b.pen", input: "two" });

  const [ra, rb] = await Promise.all([first, second]);
  assert.ok(!ra.isError, text(ra));
  assert.match(text(ra), /ECHO .*a\.pen execute\(\{"input":"one"\}\)/);
  assert.ok(!rb.isError, text(rb));
  assert.match(text(rb), /ECHO .*b\.pen execute\(\{"input":"two"\}\)/);
});

test("a timed-out call stops its editor, and its late output never reaches the next call", async () => {
  const s = await server({ PEN_MULTI_CALL_TIMEOUT_MS: "500" });
  const res = await call(s, "execute", { filePath: "slow.pen", input: "SLOW:1500" });
  assert.equal(res.isError, true);
  assert.match(text(res), /did not finish/);

  await new Promise((r) => setTimeout(r, 1500)); // when the old editor would have answered
  const next = await call(s, "execute", { filePath: "slow.pen", input: "after" });
  assert.ok(!next.isError, text(next));
  assert.match(text(next), /ECHO .*"input":"after"/);
  assert.doesNotMatch(text(next), /LATE/);
});

test("concurrent calls on one file run one at a time, in order", async () => {
  const s = await server({});
  const results = await Promise.all(
    ["SLOW:300 first", "second", "third"].map((input) => call(s, "execute", { filePath: "q.pen", input })),
  );
  results.forEach((r) => assert.ok(!r.isError, text(r)));
  assert.match(text(results[0]), /LATE .*first/);
  assert.match(text(results[1]), /ECHO .*second/);
  assert.match(text(results[2]), /ECHO .*third/);
});

test("withMachineLock excludes callers in the same process too, in order", async () => {
  process.env.PEN_MULTI_HOME = path.join(root, "lock-home"); // before the module reads its config
  const { withMachineLock } = await import("../src/pool.js");
  let inside = 0, max = 0;
  const order = [];
  await Promise.all([1, 2, 3, 4].map((n) => withMachineLock("test:same-process", async () => {
    inside++;
    max = Math.max(max, inside);
    await new Promise((r) => setTimeout(r, 20));
    order.push(n);
    inside--;
  })));
  assert.equal(max, 1);
  assert.deepEqual(order, [1, 2, 3, 4]);
});
