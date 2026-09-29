// The eval harness itself: transcript parsing, process scores, and the both-changed workspace.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { parseStream, score } from "../bench/eval/behavior.mjs";
import { check, workspace } from "../bench/eval/lib.mjs";
import { TASKS } from "../bench/eval/tasks.mjs";

const line = (o) => JSON.stringify(o);
const use = (name, input = {}) => line({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

test("parseStream reads tool calls in order and the final result", () => {
  const s = parseStream([use("mcp__pen-multi__inspect", { target: "Profile" }), "not json", use("Edit", { file_path: "/w/page.html" }), line({ type: "result", result: "done", num_turns: 3 })].join("\n"));
  assert.deepEqual(s.calls.map((c) => c.name), ["inspect", "Edit"]);
  assert.equal(s.result.num_turns, 3);
});

test("score: inspect before editing, markers, the wrong side, and conflicts reported", () => {
  const calls = [{ name: "inspect", input: {} }, { name: "Edit", input: { file_path: "/w/page.html" } }, { name: "verify", input: { direction: "code-to-design" } }];
  const port = score(TASKS.port, { calls, result: { result: "ok" } }, { before: { page: "a", pen: "x" }, after: { page: '<p data-pen="Title">', pen: "y" }, page: "page.html" });
  assert.equal(port.inspectedBeforeEdit, true);
  assert.equal(port.markers, true);
  assert.equal(port.wrongSide, true, "a design→code task changed the design");
  const both = score(TASKS["both-changed"], { calls: [], result: { result: "The title and the button color changed on different sides — which one should I keep?" } }, { before: { page: "a", pen: "x" }, after: { page: "a", pen: "x" }, page: "page.html" });
  assert.equal(both.conflictReported, true);
  assert.equal(both.bothOverwritten, false);
});

test("the both-changed workspace differs on both sides", async () => {
  const w = await workspace("both-changed", new URL("../src/index.js", import.meta.url).pathname);
  try {
    const v = await check(w, new URL("../src/index.js", import.meta.url).pathname);
    assert.equal(v.match, false, v.summary);
    assert.equal(fs.readdirSync(`${w.dir}/design-sync`).length, 1, "the earlier MATCH is recorded");
    assert.match(execFileSync("git", ["log", "--oneline"], { cwd: w.dir, encoding: "utf8" }), /matched/);
  } finally {
    fs.rmSync(w.dir, { recursive: true, force: true });
  }
});
