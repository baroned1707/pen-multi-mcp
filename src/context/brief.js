// Project context: the authored brief (product intent), the stamp of what it was written against,
// and what changed since — so agents know when the brief no longer describes the project.
// Pure helpers plus git; no model: agents write the brief, pen-multi keeps it honest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { references } from "./rules.js";

export const STAMP_FILE = "brief-stamp.json"; // in design-sync/, next to the .pen

// A file's hash, or a folder's (its files' paths and contents, bounded: a skill folder is a source).
const sha = (file) => {
  try {
    if (!fs.statSync(file).isDirectory()) return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
    const h = createHash("sha1");
    let files = 0, bytes = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files >= 2000 || bytes >= 32 << 20 || e.name === "node_modules" || e.name === ".git") continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.isFile()) {
          const b = fs.readFileSync(f);
          files++, (bytes += b.length);
          h.update(`${path.relative(file, f)}\0`).update(b);
        }
      }
    };
    walk(file);
    return h.digest("hex");
  } catch {
    return null;
  }
};
const git = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 << 20 }).trim();
  } catch {
    return null;
  }
};

/**
 * Where the brief and its sources are: .pen-multi.json { brief: { file, sources } }, default
 * design/BRIEF.md. The paths and skills the brief itself refers to are sources too.
 */
export function briefConfig(penFile, conv) {
  const base = path.dirname(penFile);
  const b = conv.brief ?? {};
  const rel = b.file ?? "design/BRIEF.md";
  const file = path.resolve(base, rel);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  // A reference is written from the project's root (next to the .pen) or from the brief's folder.
  const where = (p) => [path.resolve(base, p), path.resolve(path.dirname(file), p)].find((f) => fs.existsSync(f));
  const refs = references(text, (p) => Boolean(where(p))).map((p) => ({ rel: path.relative(base, where(p)) || p, file: where(p) }));
  const configured = (b.sources ?? []).map((s) => ({ rel: s, file: path.resolve(base, s) }));
  const seen = new Set(configured.map((s) => s.file));
  return { file, rel, sources: [...configured, ...refs.filter((r) => !seen.has(r.file) && r.file !== file)], references: refs.map((r) => r.rel) };
}

/** The brief's outline: every heading and the first line under it, at most `max` lines. */
export function digestOf(text, max = 40) {
  const out = [];
  let wantLine = false;
  let fence = false;
  for (const raw of String(text).split("\n")) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) fence = !fence;
    if (fence || /^```/.test(line)) continue; // code and pen-rules blocks: summarised apart
    const bold = /^\*\*([^*]{2,120})\*\*/.exec(line);
    if (/^#{1,4} /.test(line)) {
      out.push(line);
      wantLine = true;
    } else if (bold) {
      // A paragraph led by a bold label ("**R1. At most four text styles.**") is a rule: keep its label.
      out.push(`  ${bold[1].trim()}`);
      wantLine = false;
    } else if (wantLine && line.trim() && !/^(---|```)/.test(line.trim())) {
      out.push(line.length > 200 ? `${line.slice(0, 199)}…` : line);
      wantLine = false;
    }
    if (out.length >= max) {
      out.push("… (the full brief: project_context with detail \"full\")");
      break;
    }
  }
  return out;
}

/** What the brief is written against, now: { commit, sources, routes, components, tokens }. */
export function snapshotNow({ root, brief, routes = [], components = [], tokens = [] }) {
  return {
    at: new Date().toISOString(),
    commit: git(["rev-parse", "HEAD"], root),
    sources: Object.fromEntries(brief.sources.map((s) => [s.rel, sha(s.file)])),
    routes: [...new Set(routes)].sort(),
    components: [...new Set(components)].sort(),
    tokens: [...new Set(tokens)].sort(),
  };
}

const added = (a = [], b = []) => b.filter((x) => !a.includes(x));

/**
 * What changed between the stamp and now. `stale` is true when a source, a route, a code component
 * or a token changed; commits and files are information.
 */
export function sinceStamp(stamp, now, root) {
  const sources = Object.keys({ ...stamp.sources, ...now.sources }).filter((k) => stamp.sources?.[k] !== now.sources?.[k]);
  const d = {
    sources,
    routes: { added: added(stamp.routes, now.routes), removed: added(now.routes, stamp.routes) },
    components: { added: added(stamp.components, now.components), removed: added(now.components, stamp.components) },
    tokens: { added: added(stamp.tokens, now.tokens), removed: added(now.tokens, stamp.tokens) },
    commits: [],
    commitCount: 0,
    files: { added: [], removed: [], byDir: {} },
  };
  if (stamp.commit && now.commit && stamp.commit !== now.commit) {
    const log = git(["log", "--format=%s", `${stamp.commit}..HEAD`], root);
    if (log !== null) {
      const subjects = log.split("\n").filter(Boolean);
      d.commitCount = subjects.length;
      d.commits = subjects.slice(0, 10);
    }
  }
  if (stamp.commit) {
    const status = git(["diff", "--name-status", stamp.commit], root);
    for (const line of (status ?? "").split("\n").filter(Boolean)) {
      const [st, file] = line.split("\t");
      if (st === "A") d.files.added.push(file);
      else if (st === "D") d.files.removed.push(file);
      const top = file.includes("/") ? file.split("/")[0] : ".";
      d.files.byDir[top] = (d.files.byDir[top] ?? 0) + 1;
    }
  }
  const moved = (x) => x.added.length + x.removed.length;
  d.stale = sources.length + moved(d.routes) + moved(d.components) + moved(d.tokens) > 0;
  return d;
}

/** The "since the brief" lines. */
export function sinceLines(stamp, d) {
  const L = [`Since the brief (${stamp.at.slice(0, 10)}${stamp.commit ? `, ${stamp.commit.slice(0, 7)}` : ""}): ${d.stale ? "possibly out of date" : "nothing structural changed"}`];
  const list = (xs, n = 8) => `${xs.slice(0, n).join(", ")}${xs.length > n ? ", …" : ""}`;
  if (d.sources.length) L.push(`- sources changed: ${list(d.sources)}`);
  for (const [k, label] of [["routes", "routes"], ["components", "code components"], ["tokens", "tokens"]]) {
    const x = d[k];
    if (x.added.length || x.removed.length) L.push(`- ${label}: ${x.added.length ? `added ${list(x.added)}` : ""}${x.added.length && x.removed.length ? " · " : ""}${x.removed.length ? `removed ${list(x.removed)}` : ""}`);
  }
  if (d.commitCount) L.push(`- ${d.commitCount} commit(s): ${d.commits.slice(0, 5).map((s) => `"${s.slice(0, 60)}"`).join(", ")}${d.commitCount > 5 ? ", …" : ""}`);
  if (d.files.added.length || d.files.removed.length) L.push(`- files ${d.files.added.length ? `added ${list(d.files.added, 6)}` : ""}${d.files.added.length && d.files.removed.length ? " · " : ""}${d.files.removed.length ? `removed ${list(d.files.removed, 6)}` : ""}`);
  const dirs = Object.entries(d.files.byDir).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (dirs.length) L.push(`- changed files by folder: ${dirs.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return L;
}
