// Design ↔ code mapping, derived from the code itself:
// - markers (data-pen="…", "pen:…" in testID / Key / accessibilityIdentifier / any string) found
//   by a plain text search, so every language works the same way;
// - components: the marker on a component's definition names its file and declared name;
// - tokens: the project's token file, matched by name, then by a unique value.
// .pen-multi.json may override both; nothing here guesses a framework.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baseTheme, kebab, normalizeTokens, readCodeTokens, sameValue } from "../lint/tokens.js";

const SOURCE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|html?|dart|swift|kt|kts|java|xml|go|templ|py|rb|php|cs|cshtml|razor|erb|hbs|mdx|m|mm)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".astro", "Pods", ".dart_tool", ".gradle", "DerivedData", "vendor", "coverage", ".expo", "design-verify", "design-ref"]); // the last two are pen-multi's own output
const STATIC = [/data-pen\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/g, /["'`]pen:([^"'`\s]+)["'`]/g];
const DYNAMIC = [/data-pen\s*=\s*\{\s*(?!["'`])/, /["'`]pen:\$\{/, /["'`]pen:["'`]\s*\+/];
const DECLARATION = /\b(?:function|class|struct|interface|object|enum|fun|func|def|const|let|var)\s+([A-Z][A-Za-z0-9_]*)/;

const cache = new Map(); // root -> Map(rel -> { mtimeMs, size, hits, dyn })

/**
 * Source files under `root` as git sees them (tracked and untracked, .gitignore respected), or
 * null when `root` is not inside a git repository — then nothing is searched: walking an
 * arbitrary folder (a home directory) is slow and reads what the project never meant to share.
 * Listed on every call, so a file the agent just created is seen; file contents are cached.
 */
function listFiles(root) {
  if (root === "/" || root === os.homedir()) return null;
  let rels;
  try {
    rels = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).split("\0").filter(Boolean);
  } catch {
    return null; // not a git work tree (or git is missing)
  }
  return rels.filter((r) => SOURCE.test(r) && !r.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg)));
}

function scanFile(text) {
  const hits = [], dyn = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.includes("pen")) continue;
    for (const re of STATIC) for (const m of l.matchAll(re)) hits.push([m[1].replace(/^pen:/, ""), i + 1]);
    if (DYNAMIC.some((re) => re.test(l))) dyn.push(i + 1);
  }
  return { hits, dyn };
}

/**
 * Every marker under `root`: { markers: Map(value -> [{ file, line }]), dynamic: [{ file, line }],
 * files, truncated }. Files are re-read only when their mtime or size changed.
 */
export function scanMarkers(root, { timeoutMs = 3000, maxBytes = 1_000_000 } = {}) {
  const started = performance.now();
  const known = cache.get(root) ?? new Map();
  const next = new Map();
  let truncated = false;
  const files = listFiles(root);
  if (!files) return { markers: new Map(), dynamic: [], files: 0, truncated: false, notGit: true };
  for (const rel of files) {
    let st;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    const prev = known.get(rel);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      next.set(rel, prev);
      continue;
    }
    if (st.size > maxBytes) continue;
    if (performance.now() - started > timeoutMs) {
      truncated = true;
      continue;
    }
    if (!st.isFile()) continue;
    try {
      next.set(rel, { mtimeMs: st.mtimeMs, size: st.size, ...scanFile(fs.readFileSync(path.join(root, rel), "utf8")) });
    } catch {
      // removed or unreadable since it was listed
    }
  }
  cache.set(root, next);
  const markers = new Map(), dynamic = [];
  for (const [file, f] of [...next].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [v, line] of f.hits) {
      if (!markers.has(v)) markers.set(v, []);
      markers.get(v).push({ file, line });
    }
    for (const line of f.dyn) dynamic.push({ file, line });
  }
  return { markers, dynamic, files: next.size, truncated };
}

const stripIndex = (s) => String(s ?? "").replace(/\[\d+\]/g, "");

/**
 * Where a design node is in the code: { file, line, how } (how: id | address | name | component),
 * or { reason } when no static marker names it. `node` needs id, address, name and, for a node
 * inside an instance, instanceOf { id, name } (the component, located by its own marker).
 */
export function locate(node, idx, { prefer } = {}) {
  // One location for a marker: in the file that holds most of this screen's markers when there
  // is a choice (`prefer`: Map(file -> count)), and how many other places carry it.
  const pick = (locs) => {
    const best = prefer ? [...locs].sort((a, b) => (prefer.get(b.file) ?? 0) - (prefer.get(a.file) ?? 0))[0] : locs[0];
    return { ...best, ...(locs.length > 1 ? { also: locs.length - 1 } : {}) };
  };
  const first = (v) => {
    const locs = idx.markers.get(v);
    return locs?.length ? pick(locs) : undefined;
  };
  const byId = first(node.id);
  if (byId) return { ...byId, how: "id" };
  // The longest marker that is the node's address or a suffix of it.
  const addr = stripIndex(node.address);
  let best = null;
  for (const [v, locs] of idx.markers) {
    const w = stripIndex(v);
    if ((addr === w || addr.endsWith(`/${w}`)) && (!best || w.length > best.w.length)) best = { w, loc: pick(locs) };
  }
  if (best) return { ...best.loc, how: "address" };
  const byName = node.name && first(node.name);
  if (byName) return { ...byName, how: "name" };
  if (node.instanceOf) {
    const comp = first(node.instanceOf.id) ?? first(node.instanceOf.name);
    if (comp) return { ...comp, how: "component" };
  }
  const d = idx.dynamic.length;
  return { reason: `no static marker${d ? `; ${d} computed marker${d > 1 ? "s" : ""} (e.g. ${idx.dynamic[0].file}:${idx.dynamic[0].line}) may stand for it` : ""}` };
}

/** The declared name (function / class / struct …) nearest above a line of a file. */
function declaredName(root, file, line) {
  try {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    for (let i = line - 1; i >= 0 && i >= line - 80; i--) {
      const m = DECLARATION.exec(lines[i]);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

/**
 * Design components ({ id, name, instances }) → code: Map(id -> { code, file, line, source,
 * problem? }) with `unmapped` (most used first). A marker on the component's definition naming
 * its id or name maps it; `overrides` ({ [id]: { code, file, props } }) win and are checked.
 */
export function componentMap(components, idx, overrides = {}, root = process.cwd()) {
  const out = new Map();
  out.unmapped = [];
  for (const c of components) {
    const o = overrides[c.id];
    if (o) {
      const entry = { ...o, source: "override" };
      const file = o.file && path.join(root, o.file);
      if (o.file && !fs.existsSync(file)) entry.problem = `${o.file} does not exist`;
      else if (o.file && o.code && !fs.readFileSync(file, "utf8").includes(o.code)) entry.problem = `${o.code} is not in ${o.file}`;
      out.set(c.id, entry);
      continue;
    }
    // A definition carries the marker once. A marker found in several places sits where the
    // component is used, and the code around one of them is not the component: do not guess.
    const byId = idx.markers.get(c.id);
    const locs = byId ?? idx.markers.get(c.name) ?? [];
    const code = locs.length === 1 ? declaredName(root, locs[0].file, locs[0].line) ?? path.basename(locs[0].file).replace(/\.[^.]+$/, "") : null;
    // A marker naming the component's id is proof. By name ("Row") it is a hint, taken only when the
    // code declared there is related to that name (PriceRow for Row), not whatever encloses it.
    const norm = (x) => String(x).split("/").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
    const related = byId || (code && norm(c.name) && (norm(code).includes(norm(c.name)) || norm(c.name).includes(norm(code))));
    if (code && related) out.set(c.id, { code, file: locs[0].file, line: locs[0].line, source: "marker" });
    else out.unmapped.push(locs.length ? { ...c, usages: locs.length, near: code ?? undefined } : c);
  }
  out.unmapped.sort((a, b) => (b.instances ?? 0) - (a.instances ?? 0) || a.name.localeCompare(b.name));
  return out;
}

/**
 * Design variables → code token names: Map("$name" -> code name) with `ambiguous`
 * ([{ token, candidates }]). Same name first (kebab-case), then the only code token with the same
 * base-theme value. `overrides` ({ name | $name: codeName }) win.
 */
export function tokenMap(variables, themes, codeText, fileName = "tokens.css", overrides = {}) {
  const n = normalizeTokens(variables, themes);
  const json = /\.json$/i.test(fileName);
  const code = readCodeTokens(codeText, n, { json: json ? true : false });
  const show = (k) => (json ? k : `--${k}`);
  const base = baseTheme(n) ?? "default";
  const codeBase = new Map();
  for (const [key, v] of code) {
    const [theme, name] = key.split("|");
    if (theme === base || theme === "default" || !codeBase.has(name)) codeBase.set(name, v);
  }
  const out = new Map();
  out.ambiguous = [];
  for (const t of n.tokens) {
    const own = overrides[t.name] ?? overrides[`$${t.name}`];
    if (own) {
      out.set(`$${t.name}`, own);
      continue;
    }
    const k = kebab(t.name);
    if (codeBase.has(k)) {
      out.set(`$${t.name}`, show(k));
      continue;
    }
    const want = t.values.default ?? t.values[base] ?? Object.values(t.values)[0];
    const same = [...codeBase].filter(([, v]) => sameValue(t, want, v)).map(([name]) => show(name));
    if (same.length === 1) out.set(`$${t.name}`, same[0]);
    else if (same.length > 1) out.ambiguous.push({ token: `$${t.name}`, candidates: same.sort() });
  }
  return out;
}

const tokenCache = new Map(); // token file -> { mtimeMs, key, map }

/**
 * The mapping for one .pen, from .pen-multi.json ({ tokens: { file, map }, components: { id: … } })
 * and the code under `root`: { codeName(token), component(id), locate(node), components, tokens,
 * notes }. Cheap to call per request: markers and the token file are re-read only when changed.
 */
export function projectMapping({ penFile, conv, variables = {}, themes = {}, components = [], root = process.cwd() }) {
  let idx;
  const notes = [];
  try {
    idx = scanMarkers(root);
  } catch (err) {
    idx = { markers: new Map(), dynamic: [], files: 0, truncated: false };
    notes.push(`The marker search failed (${err.message}); code locations are not shown.`);
  }
  if (idx.truncated) notes.push("The marker search stopped at its time limit; some code locations may be missing — call again (files already read are cached).");
  if (idx.notGit) notes.push(`${root} is not inside a git repository, so code markers are not searched there (start the agent in the project's repository).`);
  let tokens = new Map();
  tokens.ambiguous = [];
  const tf = conv.tokens?.file && path.resolve(path.dirname(penFile), conv.tokens.file);
  if (tf) {
    if (!fs.existsSync(tf)) notes.push(`.pen-multi.json tokens.file ${conv.tokens.file} does not exist.`);
    else {
      const st = fs.statSync(tf);
      const key = JSON.stringify([variables, themes, conv.tokens.map ?? {}]);
      const hit = tokenCache.get(tf);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.key === key) tokens = hit.map;
      else {
        tokens = tokenMap(variables, themes, fs.readFileSync(tf, "utf8"), tf, conv.tokens.map ?? {});
        tokenCache.set(tf, { mtimeMs: st.mtimeMs, key, map: tokens });
      }
    }
  } else if (conv.tokens?.map) {
    for (const [k, v] of Object.entries(conv.tokens.map)) tokens.set(k.startsWith("$") ? k : `$${k}`, v);
  }
  const comps = componentMap(components, idx, conv.components ?? {}, root);
  return {
    index: idx,
    tokens,
    components: comps,
    notes,
    codeName: (token) => tokens.get(token),
    component: (id) => comps.get(id),
    locate: (node, opts) => locate(node, idx, opts),
  };
}
