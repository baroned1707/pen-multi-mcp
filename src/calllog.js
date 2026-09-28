// Per-call diagnostics: where a slow tool call spent its time (routing, the engine or the app,
// saving), and whether other agents were using the pen.dev app at the same time. Calls slower
// than PEN_MULTI_SLOW_MS go to ~/.pen-multi/slow.jsonl, shared by every pen-multi process.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

const store = new AsyncLocalStorage();
export const SLOW_MS = Number(process.env.PEN_MULTI_SLOW_MS ?? 3000);
const MAX_BYTES = 1_000_000;

/** Runs fn with a fresh call context. */
export const withCall = (tool, fn) => store.run({ tool, started: performance.now(), marks: {}, appOthers: 0 }, fn);
export const current = () => store.getStore();

/** Adds ms to the current call's `step`. */
export function mark(step, ms) {
  const ctx = store.getStore();
  if (ctx) ctx.marks[step] = (ctx.marks[step] ?? 0) + Math.round(ms);
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

/**
 * Marks an app call as in flight machine-wide for the duration of fn, and records in the call
 * context how many other processes' app calls were in flight when it started.
 */
export async function inAppCall(home, fn) {
  const dir = path.join(home, "app-calls");
  let own = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    let others = 0;
    for (const n of fs.readdirSync(dir)) {
      const pid = Number(n.split("-")[0]);
      if (pid === process.pid) continue;
      if (!isAlive(pid)) fs.rmSync(path.join(dir, n), { force: true });
      else others++;
    }
    const ctx = store.getStore();
    if (ctx) ctx.appOthers = Math.max(ctx.appOthers, others);
    own = path.join(dir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.writeFileSync(own, "");
  } catch {
    // diagnostics must never break a call
  }
  try {
    return await fn();
  } finally {
    if (own) fs.rmSync(own, { force: true });
  }
}

/** Appends a finished slow call to slow.jsonl (kept under ~1 MB). Returns the entry, or null. */
export function recordIfSlow(home, ctx, extra = {}) {
  const totalMs = Math.round(performance.now() - ctx.started);
  if (totalMs < SLOW_MS) return null;
  const entry = { at: new Date().toISOString(), pid: process.pid, project: process.cwd(), tool: ctx.tool, file: ctx.file, mode: ctx.mode, totalMs, marks: ctx.marks, appOthers: ctx.appOthers, ...extra };
  try {
    const file = path.join(home, "slow.jsonl");
    fs.mkdirSync(home, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      const keep = fs.readFileSync(file, "utf8").trim().split("\n").slice(-500);
      fs.writeFileSync(file, `${keep.join("\n")}\n`);
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // diagnostics must never break a call
  }
  return entry;
}

/** A likely cause for a slow call, from where its time went. */
export function cause(e) {
  const m = e.marks ?? {};
  if (e.appOthers > 0) return `${e.appOthers} other agent call(s) were using the pen.dev app at the same time; the app runs one at a time`;
  const top = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
  if (!top) return "time outside pen-multi's steps (e.g. capture, rendering or a browser)";
  const [step, ms] = top;
  const share = ms / e.totalMs;
  if (share < 0.5) return "no single step dominates";
  if (step === "call") return e.mode === "app" ? "the pen.dev app itself was slow" : "the pen engine was slow (large read, render or interrupted snippet)";
  if (step === "route") return "finding where the file is open (pen.dev app window/state queries)";
  if (step === "save") return "saving";
  return step;
}

/** The latest slow calls on this machine, newest first. */
export function recentSlow(home, limit = 10) {
  try {
    const lines = fs.readFileSync(path.join(home, "slow.jsonl"), "utf8").trim().split("\n").slice(-limit);
    return lines.reverse().map((l) => {
      const e = JSON.parse(l);
      return { at: e.at, tool: e.tool, mode: e.mode, file: e.file, totalMs: e.totalMs, marks: e.marks, appOthers: e.appOthers, cause: cause(e) };
    });
  } catch {
    return [];
  }
}
