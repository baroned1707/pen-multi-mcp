# Agent context — Phase 1 (measure first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the context pen-multi gives agents (size, redundancy, completeness), and record a v1.2.0 baseline before any context change. Also add an opt-in harness that runs real agents on fixture tasks.

**Architecture:**
- `outline()` reports which line each node landed on, through an `onNode` callback.
- A pure module, `src/metrics/context.js`, turns outline lines plus the JSON spec into metrics.
- `bench/context.mjs` runs the metrics over real `.pen` copies through any pen-multi checkout. The server path can be overridden, so v1.2.0 can be measured from a git worktree.
- `bench/eval/` drives headless `claude -p` on fixture tasks. It is a dry run unless `--run` is given.

**Tech Stack:** Node ≥20 ESM, `node:test`, `@modelcontextprotocol/sdk` client (`test/helpers.js`), the `claude` CLI (tier 2 only).

Spec: `docs/superpowers/specs/2026-09-28-agent-context-design.md` (Phase 1). Phases 2–4 get their own plans when reached, written against the code as it is then.

---

## File structure

| File | Responsibility |
|---|---|
| `src/design/inspect.js` (modify `outline`) | `onNode(id, lineIndex)` callback; no output change |
| `src/metrics/context.js` (create) | `approxTokens`, `redundancy`, `factsOf`, `completeness` — pure |
| `test/metrics.test.js` (create) | Unit tests for the metrics and for `onNode` |
| `test/helpers.js` (modify `connect`) | Server path overridable via `PEN_MULTI_SERVER` |
| `bench/context.mjs` (create) | Size / redundancy of overview + inspect on real files, JSON result |
| `package.json` (modify) | `bench:context`, `eval` scripts |
| `bench/results/context-v1.2.0.json` (create, generated) | The baseline |
| `bench/eval/run.mjs`, `bench/eval/tasks.mjs`, `bench/eval/fixtures/*` (create) | Tier 2 harness |

---

### Task 1: `outline()` reports each node's line

**Files:**
- Modify: `src/design/inspect.js` (`outline`, around line 402)
- Test: `test/metrics.test.js` (create)

- [ ] **Step 1: Write the failing test**

```js
// test/metrics.test.js
// Context metrics: what inspect gives an agent, measured (size, repetition, completeness).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/design/model.js";
import { outline, toJson } from "../src/design/inspect.js";

const node = (id, parent, b, props = {}) => ({ id, parent, depth: 0, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] }, ...props });
const raw = {
  root: "S",
  nodes: [
    node("S", null, [0, 0, 390, 844], { type: "frame", name: "Home", layout: "vertical", fill: "$bg", gap: 8 }),
    node("T", "S", [16, 16, 120, 24], { type: "text", name: "Title", content: "Today", fontSize: 18, fontWeight: "700", lineHeight: 1.25, fill: "$ink" }),
    node("C", "S", [16, 48, 358, 80], { type: "frame", name: "Card", fill: "#FAFAFA", cornerRadius: 12, padding: [16, 16] }),
    node("Ct", "C", [16, 16, 200, 20], { type: "text", name: "Body", content: "Hello there", fontSize: 14, fill: "$ink" }),
  ],
  refs: {},
  comps: {},
  variables: {
    ink: { type: "color", value: [{ value: "#111111", theme: { mode: "light" } }, { value: "#EEEEEE", theme: { mode: "dark" } }] },
    bg: { type: "color", value: "#FFFFFF" },
  },
};
export const fixtureModel = () => buildModel(structuredClone(raw));

test("outline reports the line each node is described on", () => {
  const seen = new Map();
  const lines = outline(fixtureModel(), { onNode: (id, i) => seen.set(id, i) });
  assert.deepEqual([...seen.keys()], ["S", "T", "C", "Ct"]);
  for (const [id, i] of seen) assert.match(lines[i], new RegExp(`^\\s*${{ S: "Home", T: "Title", C: "Card", Ct: "Body" }[id]} \\[`));
});
```

- [ ] **Step 2: Run it and check that it fails**

Run: `node --test test/metrics.test.js`
Expected: FAIL. The `seen` map is empty, so `deepEqual` fails.

- [ ] **Step 3: Implement**

In `src/design/inspect.js`, change the `outline` signature and the first `push` in `walk`:

```js
export function outline(model, { depth = 8, maxLines = 400, flavor, continueWith = (id) => id, onNode } = {}) {
```

```js
    const pad = "  ".repeat(level);
    if (!push(`${pad}${describe(model, n)}`)) return (truncatedAt = n.id);
    onNode?.(n.id, lines.length - 1);
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/metrics.test.js test/inspect.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/design/inspect.js test/metrics.test.js
git commit -m "feat(metrics): outline reports the line of each node"
```

---

### Task 2: Metrics module

**Files:**
- Create: `src/metrics/context.js`
- Test: `test/metrics.test.js` (append)

- [ ] **Step 1: Write the failing tests** (append to `test/metrics.test.js`)

```js
import { approxTokens, completeness, factsOf, redundancy } from "../src/metrics/context.js";

test("approxTokens counts UTF-8 bytes / 4", () => {
  assert.equal(approxTokens("abcd"), 1);
  assert.equal(approxTokens("Bản đồ"), 3); // 9 bytes
});

test("redundancy is the share of ' · ' segments already seen on an earlier line", () => {
  assert.equal(redundancy(["A · 10×10 · fill $x", "B · 20×20 · fill $x"]), 0.25);
  assert.equal(redundancy(["A · one"]), 0);
});

test("factsOf lists what an implementer needs from a node, with accepted spellings", () => {
  const nodes = toJson(fixtureModel()).nodes;
  const title = factsOf(nodes.find((n) => n.id === "T"));
  assert.deepEqual(title.map((f) => f.kind).sort(), ["color", "fontSize", "fontWeight", "size", "text"]);
  assert.ok(title.find((f) => f.kind === "color").needles.includes("$ink"));
  const card = factsOf(nodes.find((n) => n.id === "C"));
  assert.deepEqual(card.map((f) => f.kind).sort(), ["fill", "padding", "radius", "size"]);
});

test("completeness: 100% on today's outline; a dropped fact is reported with its node", () => {
  const m = fixtureModel();
  const lineOf = new Map();
  const lines = outline(m, { onNode: (id, i) => lineOf.set(id, i) });
  const nodes = toJson(m).nodes;
  const full = completeness({ lines, lineOf, nodes });
  assert.equal(full.recall, 1, JSON.stringify(full.missing));
  const cut = lines.map((l) => l.replace(/radius \S+/, ""));
  const r = completeness({ lines: cut, lineOf, nodes });
  assert.deepEqual(r.missing, [{ id: "C", kind: "radius" }]);
  // A fact given once in a defaults block counts for every node.
  const noFill = lines.map((l) => l.replace(/color \$ink\S*/, ""));
  assert.equal(completeness({ lines: noFill, lineOf, nodes, defaults: "Defaults: color $ink" }).recall, 1);
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `node --test test/metrics.test.js`
Expected: FAIL with `Cannot find module '../src/metrics/context.js'`.

- [ ] **Step 3: Implement `src/metrics/context.js`**

```js
// Metrics of the context pen-multi hands to agents: how big it is, how much of it repeats, and
// whether every fact needed to build each node is in it. Pure functions; used by tests (as
// regression guards) and by bench/context.mjs (on real files).

/** A stable token estimate: UTF-8 bytes / 4 (the same proxy for every version compared). */
export const approxTokens = (s) => Math.ceil(Buffer.byteLength(s, "utf8") / 4);

/** Share of " · "-separated facts (after the name) that already appeared on an earlier line. */
export function redundancy(lines) {
  const seen = new Set();
  let total = 0, dup = 0;
  for (const l of lines) {
    for (const seg of l.trim().split(" · ").slice(1)) {
      total++;
      if (seen.has(seg)) dup++;
      else seen.add(seg);
    }
  }
  return total ? dup / total : 0;
}

const num = (v) => String(Math.round(v * 10) / 10);
// A value may be shown as its token, its resolved value, or both; any of them counts.
const spellings = (v, resolved) => [v, resolved].filter((x) => x !== undefined && x !== null && typeof x !== "object").map(String);

/**
 * What an implementer needs from a node (from toJson), each with the spellings that count as
 * present: { kind, needles: [...] }.
 */
export function factsOf(n) {
  const r = n.resolved ?? {};
  const out = [{ kind: "size", needles: [`${num(n.bounds.w)}×${num(n.bounds.h)}`] }];
  const add = (kind, v, res) => {
    const needles = spellings(v, res);
    if (needles.length) out.push({ kind, needles });
  };
  if (n.type === "text") {
    const t = n.text ?? {};
    if (t.content) out.push({ kind: "text", needles: [String(t.content).slice(0, 20)] });
    add("fontSize", t.fontSize, r.fontSize);
    add("fontWeight", t.fontWeight, r.fontWeight);
    add("color", n.fill, r.fill);
  } else if (n.type !== "icon") {
    add("fill", n.fill, r.fill);
  }
  add("radius", n.cornerRadius, r.cornerRadius);
  if (n.stroke !== undefined) add("stroke", n.stroke, r.stroke);
  if (n.gap !== undefined) add("gap", n.gap, r.gap);
  if (n.padding !== undefined) out.push({ kind: "padding", needles: (Array.isArray(n.padding) ? n.padding : [n.padding]).map(String) });
  if (n.component?.name) out.push({ kind: "component", needles: [n.component.name] });
  if (n.icon) out.push({ kind: "icon", needles: [`${n.icon.library ?? ""}:${n.icon.icon ?? ""}`] });
  return out;
}

/**
 * Recall of facts over the nodes the outline shows (lineOf: id -> line index). A fact counts when
 * every needle-alternative... any one spelling is on the node's line or in `defaults`. Padding
 * needs all its values. Nodes not shown (collapsed rows, depth or line limit) are counted apart.
 */
export function completeness({ lines, lineOf, nodes, defaults = "" }) {
  let facts = 0, present = 0, notShown = 0;
  const missing = [];
  for (const n of nodes) {
    if (!lineOf.has(n.id)) {
      notShown++;
      continue;
    }
    const line = lines[lineOf.get(n.id)] ?? "";
    for (const f of factsOf(n)) {
      facts++;
      const has = (s) => line.includes(s) || defaults.includes(s);
      const ok = f.kind === "padding" ? f.needles.every(has) : f.needles.some(has);
      if (ok) present++;
      else missing.push({ id: n.id, kind: f.kind });
    }
  }
  return { facts, present, recall: facts ? present / facts : 1, missing, notShown };
}
```

Fix the doc comment of `completeness` while pasting it. It should read: "A fact counts when any one of its spellings is on the node's line or in `defaults`."

- [ ] **Step 4: Run the tests**

Run: `node --test test/metrics.test.js`
Expected: all pass. If `factsOf` for the Title node yields a `fontWeight` needle that the outline spells differently, check `describe()` in `src/design/inspect.js`. It prints the raw `fontWeight` value (e.g. `700`), and the needles include the raw value, so it should match.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/context.js test/metrics.test.js
git commit -m "feat(metrics): context size, redundancy and completeness"
```

---

### Task 3: `bench/context.mjs` on any checkout

**Files:**
- Modify: `test/helpers.js:5` (server path)
- Create: `bench/context.mjs`
- Modify: `package.json` scripts

- [ ] **Step 1: Make the server path overridable** in `test/helpers.js`:

```js
const serverPath = process.env.PEN_MULTI_SERVER ?? fileURLToPath(new URL("../src/index.js", import.meta.url));
```

- [ ] **Step 2: Create `bench/context.mjs`**

```js
// Measures the context agents get from overview and inspect on copies of real .pen files:
// tokens per screen, repeated facts, lines. Works against any pen-multi checkout, so a release
// can be measured as a baseline: PEN_MULTI_SERVER=/path/to/checkout/src/index.js.
// Usage: npm run bench:context -- [--screens N] [--out file.json] a.pen [b.pen ...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { call, connect, text } from "../test/helpers.js";
import { approxTokens, redundancy } from "../src/metrics/context.js";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const perFile = Number(opt("screens", 8));
const outFile = opt("out", null);
if (!argv.length) {
  console.error("Usage: npm run bench:context -- [--screens N] [--out file.json] <file.pen> [more.pen ...]");
  process.exit(2);
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-context-")));
const c = await connect({ home: path.join(root, "home"), cwd: root, env: { PEN_MULTI_PREWARM: "0" } });
const server = process.env.PEN_MULTI_SERVER ?? "working tree";
const result = { server, measuredAt: new Date().toISOString(), proxy: "tokens = UTF-8 bytes / 4", files: [] };
try {
  for (const src of argv) {
    const file = path.join(root, path.basename(src));
    fs.copyFileSync(path.resolve(src), file); // the original is never opened
    const ov = text(await call(c, "overview", { filePath: file }));
    // Screen ids from the overview matrix are not printed; take frame ids from list lines "(id)".
    const ids = [...new Set([...ov.matchAll(/\(([A-Za-z0-9]{4,8})\)/g)].map((m) => m[1]))];
    const screens = [];
    for (const id of ids) {
      if (screens.length >= perFile) break;
      const res = await call(c, "inspect", { filePath: file, target: id });
      if (res.isError) continue;
      const t = text(res);
      const outline = t.split("\n## Outline\n")[1]?.split("\n") ?? [];
      if (outline.length < 5) continue; // a component or a tiny node, not a screen
      screens.push({ id, tokens: approxTokens(t), lines: outline.length, redundancy: +redundancy(outline).toFixed(3) });
    }
    const avg = (k) => (screens.length ? +(screens.reduce((s, x) => s + x[k], 0) / screens.length).toFixed(3) : null);
    result.files.push({ file: path.basename(src), overviewTokens: approxTokens(ov), screens, avg: { tokens: avg("tokens"), lines: avg("lines"), redundancy: avg("redundancy") } });
    console.log(`${path.basename(src)}: overview ${approxTokens(ov)} tok; inspect avg ${avg("tokens")} tok, ${avg("lines")} lines, redundancy ${avg("redundancy")} over ${screens.length} screens`);
  }
} finally {
  await c.close();
  fs.rmSync(root, { recursive: true, force: true });
}
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(result, null, 1)}\n`);
  console.log(`written ${outFile}`);
}
```

- [ ] **Step 3: Add the scripts** to `package.json`:

```json
    "bench": "node bench/bench.mjs",
    "bench:context": "node bench/context.mjs",
    "eval": "node bench/eval/run.mjs"
```

- [ ] **Step 4: Smoke-run on the working tree**

Run: `npm run bench:context -- --screens 3 ../near-me/near-me.pen`
Expected: one line such as `near-me.pen: overview ~1800 tok; inspect avg … tok, … lines, redundancy 0.… over 3 screens`.

If the id regex picks up no screens, look at the overview text. Frame ids appear in the "flows" or "components" lists. In that case, use the list of ambiguous frames from `inspect` on a screen name instead, and record the change.

- [ ] **Step 5: Commit**

```bash
git add test/helpers.js bench/context.mjs package.json
git commit -m "bench: context size and redundancy on real files, any checkout"
```

---

### Task 4: Record the v1.2.0 baseline

- [ ] **Step 1: Check out v1.2.0 into a scratch worktree and install**

```bash
W=$TMPDIR/pen-multi-v120
git worktree add "$W" v1.2.0 && (cd "$W" && npm ci --silent)
```

- [ ] **Step 2: Measure the three real files with both servers**

```bash
F="../near-me/near-me.pen ../p2p-print-3d/p2p-print-3d.pen ../revert/driver-app/driversafe.pen"
PEN_MULTI_SERVER="$W/src/index.js" npm run bench:context -- --screens 8 --out bench/results/context-v1.2.0.json $F
```

Expected: three summary lines and `written bench/results/context-v1.2.0.json`.

- [ ] **Step 3: Remove the worktree**

Run: `git worktree remove "$W"`

- [ ] **Step 4: Commit the baseline**

```bash
git add bench/results/context-v1.2.0.json
git commit -m "bench: v1.2.0 context baseline"
```

---

### Task 5: Tier 2 eval harness (dry run by default)

**Files:**
- Create: `bench/eval/tasks.mjs`, `bench/eval/run.mjs`, `bench/eval/fixtures/profile.html`, `bench/eval/fixtures/profile-changed.html`

The fixture is a small profile page:
- `profile.html` is the design source. It is imported into a fresh `.pen` to make the design.
- For the task "port", the agent gets a stub page and must make it verify as MATCH.
- For the task "design-update", the code is `profile-changed.html` and the agent must update the design until verify in the code-to-design direction is MATCH. On v1.2.0, that verify is the normal one.
- For the task "fix", the code is a copy of `profile.html` with three injected differences, and the agent must fix them.

- [ ] **Step 1: Fixtures** — create `bench/eval/fixtures/profile.html`:

```html
<!doctype html><meta charset="utf-8"><body style="margin:0;font-family:Arial;background:#F8FAFC">
<header style="height:56px;background:#0F172A;color:#fff;display:flex;align-items:center;padding:0 16px"><h1 style="margin:0;font-size:20px">Profile</h1></header>
<main style="padding:16px;display:flex;flex-direction:column;gap:12px">
<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:16px;display:flex;gap:12px;align-items:center"><div style="width:48px;height:48px;border-radius:24px;background:#6366F1"></div><div><p style="margin:0;font-size:16px;font-weight:700;color:#0F172A">Ada Lovelace</p><p style="margin:4px 0 0;font-size:14px;color:#64748B">ada@example.com</p></div></div>
<button style="height:48px;border:0;border-radius:10px;background:#6366F1;color:#fff;font-size:16px;font-weight:600">Edit profile</button>
<button style="height:48px;border:1px solid #E2E8F0;border-radius:10px;background:#fff;color:#0F172A;font-size:16px">Sign out</button>
</main></body>
```

Then create `bench/eval/fixtures/profile-changed.html`. It is the same page with three edits:
- the card radius is `16px`;
- the email text color is `#475569`;
- a third button, `Delete account`, uses `background:#DC2626;color:#fff;border:0;border-radius:10px;height:48px;font-size:16px`.

- [ ] **Step 2: Tasks** — `bench/eval/tasks.mjs`:

```js
// Tier 2 eval tasks. Each builds its workspace (a .pen made by import_ui from a fixture page, and
// the code the agent starts from), gives a prompt, and checks the result with verify itself.
import fs from "node:fs";
import path from "node:path";

const FIX = new URL("./fixtures/", import.meta.url).pathname;
const stub = `<!doctype html><meta charset="utf-8"><body style="margin:0;font-family:Arial"><h1>TODO</h1></body>`;
const inject = (html) => html.replace("border-radius:12px", "border-radius:4px").replace("gap:12px;align-items", "gap:24px;align-items").replace(">Sign out<", ">Log out<");

export const TASKS = {
  port: {
    code: () => stub,
    design: "profile.html",
    prompt: (w) => `Implement the design frame "Profile" of ${w.pen} in ${w.page} (plain HTML/CSS, one file) so that pen-multi verify against file://${w.page} reports MATCH. Use the pen-multi tools. Stop when verify reports MATCH.`,
    direction: "design-to-code",
  },
  "design-update": {
    code: () => fs.readFileSync(path.join(FIX, "profile-changed.html"), "utf8"),
    design: "profile.html",
    prompt: (w) => `The page ${w.page} changed. Update the design frame "Profile" in ${w.pen} so it matches the page again: pen-multi verify against file://${w.page} must report MATCH. Edit the design with pen-multi tools; do not edit the page.`,
    direction: "code-to-design",
  },
  fix: {
    code: () => inject(fs.readFileSync(path.join(FIX, "profile.html"), "utf8")),
    design: "profile.html",
    prompt: (w) => `${w.page} implements the design frame "Profile" of ${w.pen} but verify says it differs. Fix the page until pen-multi verify against file://${w.page} reports MATCH. Do not edit the design.`,
    direction: "design-to-code",
  },
};
export const fixture = (name) => path.join(FIX, name);
```

- [ ] **Step 3: Runner** — `bench/eval/run.mjs`:

```js
// Tier 2: runs headless Claude Code agents on the eval tasks against one or two pen-multi
// checkouts and records MATCH, verify runs and tokens. Costs real tokens: a dry run (plan and
// estimate) unless --run is given.
// Usage: npm run eval -- [--run] [--n 3] [--tasks port,fix] [--servers a/src/index.js,b/src/index.js]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { call, connect, text } from "../../test/helpers.js";
import { TASKS, fixture } from "./tasks.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const n = Number(opt("n", 3));
const tasks = opt("tasks", Object.keys(TASKS).join(",")).split(",");
const here = new URL("../../src/index.js", import.meta.url).pathname;
const servers = opt("servers", here).split(",");
const EST_TOKENS_PER_RUN = 150_000; // rough: ~20 turns with inspect/verify outputs

const runs = tasks.length * servers.length * n;
console.log(`${runs} agent runs (${tasks.join(", ")} × ${servers.length} server(s) × n=${n}); estimate ~${((runs * EST_TOKENS_PER_RUN) / 1e6).toFixed(1)}M tokens.`);
if (!flag("run")) {
  console.log("Dry run. Pass --run to spend them.");
  process.exit(0);
}

async function workspace(task, server) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pen-eval-${task}-`)));
  const pen = path.join(dir, "design.pen");
  const page = path.join(dir, "page.html");
  fs.copyFileSync(fixture(TASKS[task].design), path.join(dir, "source.html"));
  const c = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_SERVER: server } });
  const res = await call(c, "import_ui", { filePath: pen, source: { kind: "web", url: `file://${path.join(dir, "source.html")}` }, name: "Profile" });
  if (res.isError) throw new Error(text(res));
  await call(c, "save", { filePath: pen });
  await c.close();
  fs.rmSync(path.join(dir, "source.html"));
  fs.writeFileSync(page, TASKS[task].code());
  return { dir, pen, page };
}

async function check(w, server) {
  const c = await connect({ home: path.join(w.dir, "home-check"), cwd: w.dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_SERVER: server } });
  try {
    const t = text(await call(c, "verify", { filePath: w.pen, target: "Profile", source: { kind: "web", url: `file://${w.page}` } }));
    return { match: /Verdict: MATCH/.test(t), summary: /Verdict: .*/.exec(t)?.[0] };
  } finally {
    await c.close();
  }
}

const results = [];
for (const server of servers) {
  for (const task of tasks) {
    for (let i = 0; i < n; i++) {
      const w = await workspace(task, server);
      const mcp = path.join(w.dir, "mcp.json");
      fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { "pen-multi": { command: process.execPath, args: [server], env: { PEN_MULTI_APP: "0", PEN_MULTI_HOME: path.join(w.dir, "home-agent") } } } }));
      const r = spawnSync("claude", ["-p", TASKS[task].prompt(w), "--mcp-config", mcp, "--strict-mcp-config", "--output-format", "json", "--permission-mode", "bypassPermissions"], { cwd: w.dir, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 64 << 20 });
      let out = {};
      try {
        out = JSON.parse(r.stdout);
      } catch {}
      const verdict = await check(w, server);
      const row = { server, task, i, match: verdict.match, verdict: verdict.summary, turns: out.num_turns, tokens: (out.usage?.input_tokens ?? 0) + (out.usage?.output_tokens ?? 0) + (out.usage?.cache_read_input_tokens ?? 0), costUsd: out.total_cost_usd, error: r.status ? (r.stderr || "").slice(0, 300) : undefined };
      results.push(row);
      console.log(JSON.stringify(row));
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  }
}
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "results", `eval-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ n, tasks, servers, git: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(), results }, null, 1)}\n`);
console.log(`written ${out}`);
```

The runner does not count verify calls: `claude -p` JSON output has no per-tool counts. That metric is dropped from the tier 2 output. The phase 4 plan can add it through `--output-format stream-json` if it is needed.

- [ ] **Step 4: Dry run**

Run: `npm run eval`
Expected: `9 agent runs (port, design-update, fix × 1 server(s) × n=3); estimate ~1.4M tokens.` then `Dry run. Pass --run to spend them.`

- [ ] **Step 5: Check the workspace builder without spending tokens.** Write and run a temporary script, not committed:

```bash
node -e 'import("./bench/eval/run.mjs")' --  # dry run only; then:
node --input-type=module -e '
import { TASKS } from "./bench/eval/tasks.mjs";
for (const [k, t] of Object.entries(TASKS)) console.log(k, t.code().length > 50 || k === "port");'
```

Expected: `port true`, `design-update true`, `fix true`.

- [ ] **Step 6: Commit**

```bash
git add bench/eval package.json
git commit -m "bench: tier 2 eval harness (dry run unless --run)"
```

---

### Task 6: Full suite and push

- [ ] Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`. Expected: `# fail 0`.
- [ ] Update `CHANGELOG.md` under a new `## Unreleased` heading:

  ```
  - Context metrics (`src/metrics/context.js`): size, repeated facts and completeness of what inspect gives agents; `npm run bench:context` measures real files against any checkout (baseline for v1.2.0 in `bench/results/`); `npm run eval` runs real agents on fixture tasks (dry run unless `--run`).
  ```

- [ ] Commit: `git commit -am "docs: changelog for context metrics"`
- [ ] `git push -u origin context`

---

## Self-review

- **Spec coverage (Phase 1):**
  - completeness → T2;
  - size and redundancy → T2, T3;
  - mapping and `file:line` accuracy → not measurable before the mapping exists, so it moves to the phase 2 plan. Its fixtures come with the mapping;
  - round trip (import → verify MATCH, share of instance- or token-bound nodes) → the existing `test/import.test.js` covers MATCH. The share metric needs phase 3's import changes, so it moves to the phase 3 plan;
  - tier 2 with confirmation and `n` → T5 (confirmation is the `--run` flag plus the printed estimate);
  - baseline → T4.
- **Placeholder scan:** the `completeness` doc comment has a garbled clause that Task 2 step 3 tells the implementer to fix. Better to fix it in the code block itself (done while implementing).
- **Types:** `onNode(id, lineIndex)` is used the same way in T1 and T2. `completeness({ lines, lineOf, nodes, defaults })` is the same in the tests and the implementation. `PEN_MULTI_SERVER` is read in `helpers.js` and passed through by `eval/run.mjs` in `connect()`'s `env`.
- **Caveat:** `connect()` reads `PEN_MULTI_SERVER` from `process.env` when the module loads, not from the `env` option. So `eval/run.mjs` must set `process.env.PEN_MULTI_SERVER`, or `connect` must accept a `server` option. This is fixed below by giving `connect` a `server` option.

**Fix for the caveat** (applies to T3 step 1): `connect({ home, cwd, env = {}, server = serverPath })` uses `args: [server]`. `bench/eval/run.mjs` passes `server` instead of `env.PEN_MULTI_SERVER`.
