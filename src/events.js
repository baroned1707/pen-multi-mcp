// Observability: one event per tool call in ~/.pen-multi/events/<day>.jsonl, shared by every
// pen-multi process on this machine. Measurements only — never arguments, texts, code or paths
// beyond names and hashes. PEN_MULTI_EVENTS=0 turns it off.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EVENTS_ON = process.env.PEN_MULTI_EVENTS !== "0";
const KEEP_DAYS = 30;
const MAX_DAY_BYTES = 20_000_000;
const h6 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 6);
export const hashTarget = (t) => (t === undefined || t === null ? null : h6(t));

/** Text and image tokens of a tool result (text: UTF-8 bytes / 4; images: ⌈w/28⌉·⌈h/28⌉ from the PNG header). */
export function resultTokens(res) {
  let text = 0, image = 0;
  for (const c of res?.content ?? []) {
    if (c.type === "text") text += Math.ceil(Buffer.byteLength(c.text ?? "") / 4);
    else if (c.type === "image" && c.data) {
      const head = Buffer.from(c.data.slice(0, 44), "base64");
      if (head.length >= 24 && head.toString("ascii", 1, 4) === "PNG") image += Math.ceil(head.readUInt32BE(16) / 28) * Math.ceil(head.readUInt32BE(20) / 28);
    }
  }
  return { text, image };
}

let lastSuggestion = null; // this process's last Next: { tool, target }

/** The event for a finished call. `ctx` is the call context (calllog), `args` the tool's arguments. */
export function buildEvent({ ctx, args = {}, res, totalMs }) {
  const text = (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const error = res?.isError ? String(text.split("\n").find((l) => l.trim() && !l.startsWith("File:")) ?? "error").slice(0, 120) : undefined;
  const target = hashTarget(args.target ?? args.id);
  const followed = lastSuggestion ? lastSuggestion.tool === ctx.tool && (!lastSuggestion.target || lastSuggestion.target === target) : undefined;
  const next = ctx.meta?.next ?? null;
  lastSuggestion = next?.tool ? { tool: next.tool, target: next.target ? hashTarget(next.target) : null } : null;
  return {
    at: new Date().toISOString(),
    pid: process.pid,
    project: `${path.basename(process.cwd())}#${h6(process.cwd())}`,
    tool: ctx.tool,
    file: ctx.file ? `${path.basename(ctx.file)}#${h6(ctx.file)}` : undefined,
    mode: ctx.mode,
    ms: Math.round(totalMs),
    marks: Object.keys(ctx.marks ?? {}).length ? ctx.marks : undefined,
    appOthers: ctx.appOthers || undefined,
    ok: !res?.isError,
    error,
    tokens: resultTokens(res),
    target: target ?? undefined,
    notes: (text.match(/^Note: /gm) ?? []).length || undefined,
    followedNext: followed,
    next: next ? { state: next.state, tool: next.tool } : undefined,
    ...(ctx.meta?.verify ? { verify: ctx.meta.verify } : {}),
  };
}

/** Appends an event to today's file (after deleting files past retention, once per process per day). */
let cleanedFor = null;
export function recordEvent(home, event) {
  if (!EVENTS_ON) return;
  try {
    const dir = path.join(home, "events");
    fs.mkdirSync(dir, { recursive: true });
    const day = event.at.slice(0, 10);
    if (cleanedFor !== day) {
      cleanedFor = day;
      const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
      for (const n of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && Date.parse(n.slice(0, 10)) < cutoff) fs.rmSync(path.join(dir, n), { force: true });
    }
    const file = path.join(dir, `${day}.jsonl`);
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_DAY_BYTES) {
      const capped = path.join(dir, `${day}.capped`);
      if (!fs.existsSync(capped)) fs.writeFileSync(capped, "");
      return;
    }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // observability must never break a call
  }
}

/** Reads events of the last `days` days (optionally one project). */
export function readEvents(home, { days = 7, project } = {}) {
  const dir = path.join(home, "events");
  const since = Date.now() - days * 86_400_000;
  const out = [];
  const capped = [];
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (n.endsWith(".capped")) capped.push(n.slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) || Date.parse(n.slice(0, 10)) < since - 86_400_000) continue;
    for (const line of fs.readFileSync(path.join(dir, n), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (Date.parse(e.at) >= since && (!project || e.project.split("#")[0] === project)) out.push(e);
      } catch {}
    }
  }
  return { events: out, capped };
}
