// Sync records: what design and code looked like the last time a frame verified as MATCH, kept in
// design-sync/ next to the .pen and meant to be committed. From them, sync_status and verify can
// say which side changed since — the design, the code, or both.
// UI texts are stored only as hashes, so nothing a running app shows (user data) enters the repo.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deltaE, parseColor, toHex } from "../verify/color.js";
import { DEFAULT_TOLERANCE } from "../verify/compare.js";

export const SYNC_DIR = "design-sync";
const r1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);
const sha = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const hex = (c) => (c ? toHex(parseColor(c) ?? c) ?? c : undefined);
const slug = (s) => String(s).normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "frame";

/** The record's path for a frame: design-sync/<name>-<width>-<theme>-<hash of file and id>.json */
export function recordPath(penFile, frame) {
  const tag = createHash("sha1").update(`${penFile}\n${frame.id}`).digest("hex").slice(0, 6);
  return path.join(path.dirname(penFile), SYNC_DIR, `${slug(frame.name ?? frame.id)}-${Math.round(frame.width ?? 0)}-${slug(frame.theme ?? "default")}-${tag}.json`);
}

const box = (b) => b && { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) };
const sorted = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).sort(([a], [b]) => a.localeCompare(b)));

/** A design node's facts, as compare sees them. */
const designFacts = (n) => sorted({ box: box(n.box), text: n.text, fill: hex(n.fill), color: hex(n.color), stroke: hex(n.stroke), fontSize: r1(n.fontSize), fontWeight: n.fontWeight, lineHeight: r1(n.lineHeight), radius: r1(n.radius) });
/** A UI element's facts, texts hashed. */
const uiFacts = (el) => sorted({ box: box(el.box), text: el.text ? sha(String(el.text).trim()) : undefined, bg: hex(el.bg), fg: hex(el.fg), border: el.borderWidth > 0 ? hex(el.borderColor) : undefined, fontSize: r1(el.fontSize), fontWeight: el.fontWeight, lineHeight: r1(el.lineHeight), radius: r1(el.radius) });

function gitState(root) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return null;
  }
}

/**
 * The record for a MATCH: `design` from designNodes, `pairs` [[designId, element]] from the match,
 * `fields` the facts the source provided.
 */
export function buildRecord({ penFile, penSha, frame, design, pairs, fields = [], source = null, root = process.cwd() }) {
  const els = new Map(pairs);
  const nodes = {};
  for (const n of design.nodes) {
    const el = els.get(n.id);
    nodes[n.address ?? n.id] = sorted({ id: n.id, kind: n.kind, design: designFacts(n), ui: el ? uiFacts(el) : undefined });
  }
  const src = source && sorted({ kind: source.kind, url: source.url, state: source.state, platform: source.platform, path: source.path, mocks: source.mocks?.length ? source.mocks.map((m) => m.file ?? m.url) : undefined });
  return {
    note: "Written by pen-multi verify on MATCH; derived data — after a merge conflict, run verify again to regenerate it.",
    version: 1,
    frame: sorted({ id: frame.id, name: frame.name, width: r1(frame.width), theme: frame.theme, fill: hex(frame.fill) }),
    pen: sorted({ path: path.basename(penFile), sha1: penSha }),
    code: gitState(root),
    source: src,
    coverage: [...fields].sort(),
    verifiedAt: new Date().toISOString(),
    nodes: sorted(nodes),
  };
}

export function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

export function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const same = (k, a, b, tol) => {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (k === "box") return ["x", "y", "w", "h"].every((p) => Math.abs((a[p] ?? 0) - (b[p] ?? 0)) <= tol.position);
  if (["fill", "color", "stroke", "bg", "fg", "border"].includes(k)) {
    const ca = parseColor(a), cb = parseColor(b);
    return ca && cb ? deltaE(ca, cb) <= tol.color : a === b;
  }
  if (k === "fontSize") return Math.abs(a - b) <= tol.fontSize;
  if (k === "fontWeight") return Math.abs(a - b) < tol.fontWeight;
  if (k === "lineHeight") return Math.abs(a - b) <= tol.lineHeight;
  if (k === "radius") return Math.abs(a - b) <= tol.radius;
  return false;
};

/**
 * Differences between two fact maps by address: { added, removed, changed: [{ address, prop,
 * from, to }] }. `side` picks design or ui facts; changes within compare's tolerances are none.
 */
export function factsDiff(before, after, side, tolerance = {}) {
  // The design is exact data: any change counts. The UI is a capture: compare's tolerances apply.
  const EXACT = { position: 0.5, color: 0.5, fontSize: 0.01, fontWeight: 1, lineHeight: 0.01, radius: 0.01 };
  const tol = side === "design" ? EXACT : { ...DEFAULT_TOLERANCE, ...tolerance };
  const added = [], removed = [], changed = [];
  for (const [address, n] of Object.entries(after)) {
    const was = before[address]?.[side];
    const now = n[side];
    if (!now) continue;
    if (!was) {
      added.push(address);
      continue;
    }
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (!same(k, was[k], now[k], tol)) changed.push({ address, prop: k === "text" && side === "ui" ? "text (changed)" : k, from: side === "ui" && k === "text" ? undefined : was[k], to: side === "ui" && k === "text" ? undefined : now[k] });
    }
  }
  for (const [address, n] of Object.entries(before)) if (n[side] && !after[address]?.[side]) removed.push(address);
  // A whole subtree added or removed is its outermost node; content changes before moves.
  const outermost = (list) => list.filter((a) => !list.some((p) => p !== a && a.startsWith(`${p}/`)));
  const rank = (c) => (c.prop === "box" ? 1 : 0);
  return { added: outermost(added), removed: outermost(removed), changed: changed.sort((a, b) => rank(a) - rank(b)) };
}

/** The frame's own fill (its background), which is not one of the compared nodes. */
export function frameDiff(before, after) {
  const was = before?.fill, now = after?.fill;
  if (was === now || (!was && !now)) return [];
  const ca = parseColor(was), cb = parseColor(now);
  if (ca && cb && deltaE(ca, cb) <= 0.5) return []; // design data is exact
  return [{ address: after?.name ?? before?.name, prop: "fill", from: was, to: now }];
}

/** Files of the code changed since the record's commit (working tree included), or null when unknown. */
export function codeFilesChanged(record, files, root = process.cwd()) {
  if (!record.code?.commit || !files.length) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", record.code.commit, "--", ...files], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean);
  } catch {
    return null; // the commit is not in this history (rebased, squashed, another clone)
  }
}

/**
 * A frame's state from what changed on each side. Both sides changed is a conflict
 * ("both-changed") only when they touched the same nodes (`overlap`); changes in different places
 * ("diverged") can each be carried to the other side. `overlap` undefined means unknown: a conflict.
 */
export function syncState({ record, lastVerdict, designChanged, codeChanged, overlap }) {
  if (!record) return lastVerdict ? (lastVerdict === "match" ? "match" : "differs") : "never";
  if (designChanged && codeChanged) return overlap === false ? "diverged" : "both-changed";
  if (designChanged) return "design-changed";
  if (codeChanged) return "code-changed";
  return "in-sync";
}

/** Short text for a diff: "+ a, - b, ~ c fill #111 → #222". */
export function diffText(d, max = 8) {
  const items = [
    ...d.added.map((a) => `+ ${a}`),
    ...d.removed.map((a) => `- ${a}`),
    ...d.changed.map((c) => `~ ${c.address} ${c.prop}${c.from !== undefined || c.to !== undefined ? ` ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}` : ""}`),
  ];
  return items.length ? `${items.slice(0, max).join("; ")}${items.length > max ? `; … ${items.length - max} more` : ""}` : "";
}
