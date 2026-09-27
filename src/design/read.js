// Drives the read snippets through a `run(input) -> { text, error }` function (headless shell or
// the app), splitting reads that the engine interrupts for running too long.
import { readRoots, readStats, readTree } from "./snippets.js";

export class ReadError extends Error {}

const printed = (text, label) => {
  const m = new RegExp(`^${label} (.*)$`, "m").exec(text ?? "");
  if (!m) throw new ReadError(`the ${label} read returned no data:\n${String(text).slice(0, 400)}`);
  return JSON.parse(m[1]);
};
const interrupted = (error) => /\binterrupted\b|timed out/i.test(error ?? "");

/**
 * Reads the subtree under `rootId`, at most `maxNodes` nodes in total. When the engine interrupts
 * the whole read, the root is read with its children only, then each child subtree separately
 * with what is left of the budget, recursively, and stitched back together.
 */
export async function readSubtree(run, rootId, { maxNodes = 4000 } = {}) {
  const budget = { left: maxNodes };
  return readWithin(run, rootId, budget);
}

async function readWithin(run, rootId, budget) {
  const res = await run(readTree(rootId, { maxNodes: Math.max(1, budget.left) }));
  if (!res.error) {
    const tree = printed(res.text, "TREE");
    budget.left -= tree.nodes.length;
    return tree;
  }
  if (!interrupted(res.error)) throw new ReadError(res.error);

  const shallow = await run(readTree(rootId, { maxNodes: Math.max(1, budget.left), maxDepth: 1 }));
  if (shallow.error) throw new ReadError(shallow.error);
  const head = printed(shallow.text, "TREE");
  const top = head.nodes.find((n) => n.id === rootId);
  const kids = head.nodes.filter((n) => n.parent === rootId);
  budget.left -= 1 + kids.length;
  const merged = { ...head, nodes: [top, ...kids], skipped: head.skipped ?? 0 };
  for (const kid of kids) {
    if (budget.left <= 0) {
      merged.skipped += 1; // at least the unread subtree's own children
      continue;
    }
    budget.left += 1; // the child itself was already counted
    const sub = await readWithin(run, kid.id, budget);
    for (const n of sub.nodes) if (n.id !== kid.id) merged.nodes.push(n);
    Object.assign(merged.refs, sub.refs);
    Object.assign(merged.comps, sub.comps);
    merged.skipped += sub.skipped ?? 0;
  }
  return merged;
}

/** Root nodes, variables, and per-root statistics read in batches (halved when interrupted). Each engine call costs ~400 ms however little it reads, so batches are large. */
export async function readOverview(run, { batch = 600 } = {}) {
  const res = await run(readRoots());
  if (res.error) throw new ReadError(res.error);
  const data = printed(res.text, "ROOTS");
  const stats = {};
  const unavailable = [];
  const readBatch = async (ids) => {
    const r = await run(readStats(ids));
    if (!r.error) return Object.assign(stats, printed(r.text, "STATS"));
    if (!interrupted(r.error)) throw new ReadError(r.error);
    if (ids.length === 1) return unavailable.push(ids[0]);
    const half = Math.ceil(ids.length / 2);
    await readBatch(ids.slice(0, half));
    await readBatch(ids.slice(half));
  };
  const ids = data.roots.filter((r) => r.type === "frame" || r.type === "group").map((r) => r.id);
  for (let i = 0; i < ids.length; i += batch) await readBatch(ids.slice(i, i + batch));
  return { data, stats, unavailable };
}
