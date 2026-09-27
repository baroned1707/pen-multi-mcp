import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/design/model.js";
import { readOverview, readSubtree } from "../src/design/read.js";

// A fake engine: a document tree, and reads of whole subtrees larger than `limit` nodes are interrupted.
const doc = {
  S: { parent: null, b: [500, 0, 390, 844], kids: ["A", "B"] },
  A: { parent: "S", b: [0, 0, 390, 400], kids: ["A1", "A2"] },
  A1: { parent: "A", b: [10, 20, 100, 30], kids: [] },
  A2: { parent: "A", b: [10, 60, 100, 30], kids: [] },
  B: { parent: "S", b: [0, 400, 390, 444], kids: ["B1"] },
  B1: { parent: "B", b: [5, 5, 50, 50], kids: [] },
};
const subtree = (id, depth, maxDepth) => {
  const n = doc[id];
  const out = [{ id, parent: depth === 0 ? null : n.parent, depth, type: "frame", name: id, bounds: { x: n.b[0], y: n.b[1], width: n.b[2], height: n.b[3] } }];
  if (depth < maxDepth) for (const k of n.kids) out.push(...subtree(k, depth + 1, maxDepth));
  return out;
};
const fakeRun = (limit, calls) => async (input) => {
  const root = /const ROOT = "(\w+)"/.exec(input)[1];
  const maxDepth = Number(/c\.depth > (\d+)\) \{ skipped/.exec(input)[1]);
  const maxNodes = Number(/nodes\.length >= (\d+)\)/.exec(input)[1]);
  calls.push([root, maxDepth]);
  const all = subtree(root, 0, maxDepth);
  const nodes = all.slice(0, maxNodes); // like the engine, stop at the cap
  if (nodes.length > limit) return { error: "Failed to execute: InternalError: interrupted" };
  return { text: `OK\n\n## Print output\nTREE ${JSON.stringify({ root, nodes, skipped: all.length - nodes.length, refs: {}, comps: {}, variables: {}, themes: {} })}` };
};

test("an interrupted read is split into the root and each child subtree, then stitched back correctly", async () => {
  const calls = [];
  const raw = await readSubtree(fakeRun(3, calls), "S");
  assert.deepEqual(raw.nodes.map((n) => n.id).sort(), ["A", "A1", "A2", "B", "B1", "S"]);
  const m = buildModel(raw);
  assert.equal(m.nodes.get("A1").parent, "A");
  assert.deepEqual(m.nodes.get("A2").abs, { x: 10, y: 60, w: 100, h: 30 });
  assert.deepEqual(m.nodes.get("B1").abs, { x: 5, y: 405, w: 50, h: 50 }, "child subtree bounds stay parent-relative");
  assert.ok(calls.some(([r, d]) => r === "S" && d === 1), "the root was re-read shallow");
});

test("a read that is interrupted even for a leaf-sized subtree fails with the engine error", async () => {
  await assert.rejects(readSubtree(fakeRun(0, []), "S"), /interrupted/);
});

test("other engine errors are not retried", async () => {
  const calls = [];
  const run = async (input) => (calls.push(input), { error: "Node not found: S" });
  await assert.rejects(readSubtree(run, "S"), /Node not found/);
  assert.equal(calls.length, 1);
});

test("statistics batches are halved on interruption down to single roots", async () => {
  const roots = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, type: "frame", name: `r${i}`, bounds: { x: 0, y: i * 1000, width: 390, height: 844 } }));
  const run = async (input) => {
    if (input.includes('Print("ROOTS"')) return { text: `ROOTS ${JSON.stringify({ roots, variables: {}, themes: {} })}` };
    const ids = JSON.parse(/const IDS = (\[.*?\]);/.exec(input)[1]);
    if (ids.length > 2 || ids.includes("r4")) return { error: "InternalError: interrupted" };
    return { text: `STATS ${JSON.stringify(Object.fromEntries(ids.map((id) => [id, { nodes: 1, refs: {} }])))}` };
  };
  const { stats, unavailable } = await readOverview(run, { batch: 5 });
  assert.deepEqual(Object.keys(stats).sort(), ["r0", "r1", "r2", "r3"]);
  assert.deepEqual(unavailable, ["r4"]);
});

test("the node budget holds across split reads, and what was left out is counted", async () => {
  const calls = [];
  // Every whole-subtree read of more than one node is interrupted, so everything is split.
  const raw = await readSubtree(fakeRun(3, calls), "S", { maxNodes: 4 });
  assert.ok(raw.nodes.length <= 4, `read ${raw.nodes.length} nodes with a budget of 4`);
  assert.ok(raw.skipped > 0, "the nodes past the budget are reported");
});
