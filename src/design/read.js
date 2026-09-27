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
 * Reads the subtree under `rootId`. When the engine interrupts the whole read, the root is read
 * alone and each child subtree separately, recursively, then stitched back together.
 */
export async function readSubtree(run, rootId, { maxNodes = 4000 } = {}) {
  const res = await run(readTree(rootId, { maxNodes }));
  if (!res.error) return printed(res.text, "TREE");
  if (!interrupted(res.error)) throw new ReadError(res.error);

  const shallow = await run(readTree(rootId, { maxNodes, maxDepth: 1 }));
  if (shallow.error) throw new ReadError(shallow.error);
  const head = printed(shallow.text, "TREE");
  const top = head.nodes.find((n) => n.id === rootId);
  const kids = head.nodes.filter((n) => n.parent === rootId);
  const merged = { ...head, nodes: [top, ...kids], skipped: 0 };
  for (const kid of kids) {
    const sub = await readSubtree(run, kid.id, { maxNodes });
    for (const n of sub.nodes) if (n.id !== kid.id) merged.nodes.push(n);
    Object.assign(merged.refs, sub.refs);
    Object.assign(merged.comps, sub.comps);
    merged.skipped += sub.skipped ?? 0;
  }
  return merged;
}

/** Root nodes, variables, and per-root statistics read in batches (halved when interrupted). */
export async function readOverview(run, { batch = 50 } = {}) {
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
