# pen-multi speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut pen-multi's per-call latency (app-routed `execute` ≤ 0.6 s, headless ≤ 0.5 s) by caching the expensive app state and saving in the background, without weakening routing safety.

**Architecture:** `AppBridge` reads the window list fresh on every call (shared in-flight) and caches the active document with a TTL, re-reading it where a stale value could misroute a write. A new `SaveScheduler` saves dirty files after an idle delay instead of before responding, and is flushed wherever the file must be on disk. A small `Timings` module feeds `list_sessions`.

**Tech Stack:** Node 22 ESM, `@modelcontextprotocol/sdk`, `node:test`. Spec: `docs/superpowers/specs/2026-09-24-pen-multi-speed-design.md`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/timing.js` | create | rolling latency samples, median/p90 |
| `src/saver.js` | create | per-file debounced, non-overlapping saves; flush; error memory |
| `src/app.js` | modify | async shared window list, TTL-cached active document, `fresh` option, `invalidate()` |
| `src/pool.js` | modify | accept a saver; flush it before closing a session |
| `src/index.js` | modify | fresh routing rules, background saves, `save`/`close_file`/`fork_version`/shutdown flush, instructions, `list_sessions` fields |
| `test/timing.test.js`, `test/saver.test.js` | create | unit tests |
| `test/fake-app.mjs` | modify | count `get_app_state` calls |
| `test/app.test.js`, `test/server.test.js`, `test/multi-agent.test.js` | modify | new routing tests; call `save` where tests read disk |
| `README.md`, `package.json` | modify | docs, version 0.5.0 |

---

### Task 1: Timings

**Files:** Create `src/timing.js`, `test/timing.test.js`

- [ ] **Step 1: Write the failing test** — `test/timing.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { Timings } from "../src/timing.js";

test("summary reports median and p90 per step over the most recent samples", () => {
  const t = new Timings(5);
  for (const ms of [100, 1, 2, 3, 4, 5]) t.record("call", ms); // 100 falls out of the window
  assert.deepEqual(t.summary(), { call: { n: 5, medianMs: 3, p90Ms: 5 } });
});

test("time() records how long an async function took and returns its result", async () => {
  const t = new Timings();
  const out = await t.time("route", async () => {
    await new Promise((r) => setTimeout(r, 20));
    return "x";
  });
  assert.equal(out, "x");
  assert.ok(t.summary().route.medianMs >= 15);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test test/timing.test.js` → FAIL (`Cannot find module '../src/timing.js'`).

- [ ] **Step 3: Implement** — `src/timing.js`:

```js
/** Rolling latency samples per step, for list_sessions. */
export class Timings {
  constructor(limit = 200) {
    this.limit = limit;
    this.samples = new Map();
  }

  record(step, ms) {
    const list = this.samples.get(step) ?? [];
    list.push(ms);
    if (list.length > this.limit) list.shift();
    this.samples.set(step, list);
  }

  async time(step, fn) {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.record(step, Math.round(performance.now() - started));
    }
  }

  summary() {
    const out = {};
    for (const [step, list] of this.samples) {
      const sorted = [...list].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      out[step] = { n: sorted.length, medianMs: at(0.5), p90Ms: at(0.9) };
    }
    return out;
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `node --test test/timing.test.js` → 2 pass.

- [ ] **Step 5: Commit** — `git add src/timing.js test/timing.test.js && git commit -m "feat: rolling latency timings"`

---

### Task 2: SaveScheduler

**Files:** Create `src/saver.js`, `test/saver.test.js`

- [ ] **Step 1: Write the failing tests** — `test/saver.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { SaveScheduler } from "../src/saver.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a burst of writes to one file causes one save after the delay", async () => {
  let saves = 0;
  const s = new SaveScheduler({ delayMs: 50 });
  for (let i = 0; i < 5; i++) s.markDirty("a.pen", async () => saves++);
  assert.equal(saves, 0, "nothing saved before responding");
  await sleep(120);
  assert.equal(saves, 1);
  assert.deepEqual(s.pending(), []);
});

test("flush saves now and waits; a flush during a save waits for it", async () => {
  let saves = 0;
  const s = new SaveScheduler({ delayMs: 10_000 });
  s.markDirty("a.pen", async () => {
    await sleep(50);
    saves++;
  });
  await s.flush("a.pen");
  assert.equal(saves, 1);
  await s.flush("a.pen"); // nothing pending: returns at once
  assert.equal(saves, 1);
});

test("saves of one file never overlap; a write during a save schedules another", async () => {
  let running = 0, maxRunning = 0, saves = 0;
  const save = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await sleep(40);
    running--;
    saves++;
  };
  const s = new SaveScheduler({ delayMs: 10 });
  s.markDirty("a.pen", save);
  await sleep(20); // first save is running
  s.markDirty("a.pen", save);
  await s.flush("a.pen");
  assert.equal(maxRunning, 1);
  assert.equal(saves, 2);
});

test("a failed save is remembered until a later save succeeds", async () => {
  const s = new SaveScheduler({ delayMs: 10 });
  s.markDirty("a.pen", async () => {
    throw new Error("disk full");
  });
  await s.flush("a.pen").catch(() => {});
  assert.match(s.error("a.pen"), /disk full/);
  s.markDirty("a.pen", async () => {});
  await s.flush("a.pen");
  assert.equal(s.error("a.pen"), null);
});

test("flushAll saves every pending file", async () => {
  const saved = [];
  const s = new SaveScheduler({ delayMs: 10_000 });
  for (const f of ["a.pen", "b.pen"]) s.markDirty(f, async () => saved.push(f));
  await s.flushAll();
  assert.deepEqual(saved.sort(), ["a.pen", "b.pen"]);
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/saver.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/saver.js`:

```js
/**
 * Saves files in the background. A write marks its file dirty and returns at once; the save
 * runs once the file has had no writes for `delayMs`. Saves of one file never overlap: a write
 * during a save marks the file dirty again. flush() saves now and waits.
 */
export class SaveScheduler {
  constructor({ delayMs = 1500, onError = () => {} } = {}) {
    this.delayMs = delayMs;
    this.onError = onError;
    this.files = new Map(); // file -> { save, dirty, timer, running, error }
  }

  #entry(file) {
    let e = this.files.get(file);
    if (!e) {
      e = { save: null, dirty: false, timer: null, running: null, error: null };
      this.files.set(file, e);
    }
    return e;
  }

  markDirty(file, save) {
    const e = this.#entry(file);
    e.save = save;
    e.dirty = true;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this.#run(file).catch(() => {}), this.delayMs);
    e.timer.unref?.();
  }

  async #run(file) {
    const e = this.#entry(file);
    clearTimeout(e.timer);
    e.timer = null;
    if (e.running) await e.running.catch(() => {});
    if (!e.dirty) return;
    e.dirty = false;
    e.running = e.save().then(
      () => {
        e.error = null;
      },
      (err) => {
        e.error = err.message;
        this.onError(file, err);
        throw err;
      },
    );
    try {
      await e.running;
    } finally {
      e.running = null;
    }
  }

  /** Saves `file` now if it has unsaved writes, and waits for any save in progress. */
  async flush(file) {
    const e = this.files.get(file);
    if (!e) return;
    if (e.dirty) return this.#run(file);
    if (e.running) await e.running;
  }

  async flushAll() {
    await Promise.allSettled([...this.files.keys()].map((f) => this.flush(f)));
  }

  error(file) {
    return this.files.get(file)?.error ?? null;
  }

  pending() {
    return [...this.files].filter(([, e]) => e.dirty || e.running).map(([f]) => f);
  }

  errors() {
    return Object.fromEntries([...this.files].filter(([, e]) => e.error).map(([f, e]) => [f, e.error]));
  }
}
```

- [ ] **Step 4: Run to verify they pass** — `node --test test/saver.test.js` → 5 pass.

- [ ] **Step 5: Commit** — `git add src/saver.js test/saver.test.js && git commit -m "feat: background save scheduler"`

---

### Task 3: AppBridge — fresh window list, cached active document

**Files:** Modify `src/app.js` (constructor; `activeFile`, `openFiles`, `#windowFiles`; `userActiveFile`; `ensureWorkbench`), `test/fake-app.mjs`, `test/app.test.js`

- [ ] **Step 1: Make the fake app count `get_app_state` calls** — in `test/fake-app.mjs`, inside the `get_app_state` handler, before the `const { active } = state();` line, add:

```js
  update({ stateCalls: (state().stateCalls ?? 0) + 1 });
```

- [ ] **Step 2: Write the failing tests** — append to `test/app.test.js` (they use the existing `s`, `setApp`, `appState`, `live`, `background`, `doc`, `withApp`, `agent`):

```js
test("a window closed after the active document was cached: the next write goes headless", async () => {
  await call(s, "get_app_state", {}); // caches the active document
  setApp({ active: live, open: [live] }); // the user closes background.pen
  const res = await call(s, "execute", { filePath: background, input: "after-close" });
  assert.match(text(res), /ECHO .*background\.pen/, "headless");
  assert.doesNotMatch(text(res), /APP-EXECUTE/);
  await call(s, "close_file", { filePath: background });
});

test("a write without filePath after the active tab changed goes to the new tab", async () => {
  await call(s, "get_app_state", {}); // caches live.pen as active
  setApp({ active: background, open: [live, background] });
  const res = await call(s, "execute", { input: "no-path" });
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${background} input=no-path`));
});

test("a dashboard-opened document that was closed does not receive the write", async () => {
  const dash = doc("dashboard.pen"); // active, but not in the window list
  setApp({ active: dash, open: [live] });
  await call(s, "get_app_state", {}); // caches dash as active
  setApp({ active: live, open: [live] }); // the user closes it
  const res = await call(s, "execute", { filePath: dash, input: "w" });
  assert.doesNotMatch(text(res), /APP-EXECUTE/);
  await call(s, "close_file", { filePath: dash });
});

test("reads reuse the cached active document; concurrent calls share one request", async () => {
  const fresh = await agent(withApp({ PEN_MULTI_APP_STATE_TTL_MS: "60000" }));
  await call(fresh, "get_app_state", {});
  const before = appState().stateCalls ?? 0;
  await Promise.all([1, 2, 3, 4].map(() => call(fresh, "get_app_state", { filePath: live })));
  assert.equal((appState().stateCalls ?? 0) - before, 4, "one proxied report per call, no extra active lookups");
  const reads = (appState().stateCalls ?? 0);
  await Promise.all([1, 2, 3].map(() => call(fresh, "execute", { filePath: background, input: "r" })));
  assert.equal(appState().stateCalls ?? 0, reads, "writes to a document in the window list need no active lookup");
});

test("the active document is re-read after the TTL", async () => {
  const short = await agent(withApp({ PEN_MULTI_APP_STATE_TTL_MS: "200" }));
  await call(short, "list_sessions", {});
  setApp({ active: background, open: [live, background] });
  await new Promise((r) => setTimeout(r, 300));
  const list = JSON.parse(text(await call(short, "list_sessions", {})));
  assert.equal(list.desktopApp.activeDocument, background);
});
```

- [ ] **Step 3: Run to verify they fail** — `node --test --test-concurrency=1 test/app.test.js` → the "concurrent calls" test fails (lookups per call), and the others may pass or fail depending on timing; all must pass after Step 5.

- [ ] **Step 4: Implement in `src/app.js`**

In `appConfig`, add:

```js
  stateTtlMs: Number(process.env.PEN_MULTI_APP_STATE_TTL_MS ?? 2000),
```

In the `AppBridge` constructor, add:

```js
    this.activeCache = null; // { file, at }
    this.activeInFlight = null;
    this.windowsInFlight = null;
```

Replace `activeFile()` and `openFiles()` with:

```js
  /**
   * Resolved path of the document in the app's active window, or null. Cached for
   * stateTtlMs; pass { fresh: true } where a stale answer could misroute a write.
   * Concurrent callers share one request.
   */
  async activeFile({ fresh = false } = {}) {
    if (!(await this.available())) return null;
    const cached = this.activeCache;
    if (!fresh && cached && Date.now() - cached.at < appConfig.stateTtlMs) return cached.file;
    this.activeInFlight ??= (async () => {
      const res = await this.call("get_app_state");
      const match = ACTIVE.exec(textOf(res));
      const file = match ? this.resolvePath(match[1]) : null;
      this.activeCache = { file, at: Date.now() };
      return file;
    })().finally(() => (this.activeInFlight = null));
    return this.activeInFlight;
  }

  /** Forget the cached active document (after errors, or when pen-multi changed the app's windows). */
  invalidate() {
    this.activeCache = null;
  }

  /** Documents with their own app window. Read fresh every time; concurrent callers share one read. */
  async windowFiles() {
    if (!(await this.available())) return new Set();
    this.windowsInFlight ??= this.#readWindowFiles()
      .then((files) => new Set(files.map((f) => this.resolvePath(f))))
      .finally(() => (this.windowsInFlight = null));
    return this.windowsInFlight;
  }

  /**
   * Documents open in the app: every window's document plus the active one (documents opened
   * from the app's dashboard have no window entry). The official server routes a filePath
   * correctly to any open document; only unopened ones fall back to the active document.
   */
  async openFiles({ fresh = false } = {}) {
    const [windows, active] = await Promise.all([this.windowFiles(), this.activeFile({ fresh }).catch(() => null)]);
    return active ? new Set([...windows, active]) : windows;
  }
```

Replace the synchronous `#windowFiles()` with an async `#readWindowFiles()`:

```js
  async #readWindowFiles() {
    if (appConfig.docsFile) {
      try {
        const docs = JSON.parse(fs.readFileSync(appConfig.docsFile, "utf8"));
        return Array.isArray(docs) ? docs : (docs.open ?? []);
      } catch {
        return [];
      }
    }
    const ps = await new Promise((resolve) =>
      execFile("ps", ["-axww", "-o", "command="], { maxBuffer: 32 << 20 }, (err, out) => resolve(err ? "" : out)),
    );
    const files = [];
    for (const line of ps.split("\n")) {
      if (!line.includes("Pen Helper (Renderer)")) continue;
      for (const [, uri] of line.matchAll(/"fileURI":"(file:\/\/[^"]+)"/g)) {
        try {
          files.push(fileURLToPath(uri));
        } catch {}
      }
    }
    return files;
  }
```

In `call()`, invalidate on connection failure — in the `catch` block, before `this.#reset();` add `this.invalidate();`.

In `openInBackground()`, make both checks fresh: replace `(await this.openFiles()).has(file)` (two places) with `(await this.openFiles({ fresh: true })).has(file)`, and add `this.invalidate();` as the first line of the method.

In `userActiveFile()`, accept and pass through `fresh`:

```js
  async userActiveFile({ fresh = false } = {}) {
    const active = await this.activeFile({ fresh });
    if (active !== this.workbenchFile) return active;
    try {
      const remembered = fs.readFileSync(`${this.workbenchFile}.user-active`, "utf8").trim();
      return (await this.windowFiles()).has(remembered) ? remembered : null;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 5: Implement the routing rules in `src/index.js` `route()`** — change the signature to `async function route(f, { needsApp = false, tool: toolName, write = false } = {})`, and:

Replace `const active = appUp ? await app.userActiveFile() : null;` with:

```js
    // A write without filePath targets whatever is active now, so never trust the cache for it.
    const active = appUp ? await app.userActiveFile({ fresh: write }) : null;
```

Replace the block starting `if (!(await app.openFiles()).has(file)) {` down to its closing `}` (the one that returns `{ mode: "headless", file }`) with:

```js
  const windows = await app.windowFiles();
  let openInApp = windows.has(file);
  if (!openInApp) {
    // Dashboard-opened documents have no window entry and are only known as the active one.
    // For a write, confirm that with a fresh read rather than a cached one that may be stale.
    openInApp = (await app.activeFile({ fresh: write }).catch(() => null)) === file;
  }
  if (!openInApp) {
    // Opening the user's file in the app would put a window in front of whatever they are doing.
    if (needsApp) {
      throw new Error(
        [`This needs ${file} open in the pen.dev app, and pen-multi never opens windows for you.`, APP_ONLY_HELP[toolName]]
          .filter(Boolean)
          .join(" "),
      );
    }
    return { mode: "headless", file };
  }
```

In the conflict branch (`if (pool.sessions.has(file)) { throw ... }`) add `app.invalidate();` before the `throw`.

Pass `write: true` from every write path: in the `execute` handler `route(f, { write: true })`; in `spawn_agents` `route(f, { needsApp: true, tool: "spawn_agents", write: true })`; in `browser` for canvas actions `route(f, { write: true })` and in `browserNode` `route(f, { needsApp: true, tool: "browser", write: !reading })`. `get_app_state` keeps `route(f)`.

In `ensureWorkbench()` (src/app.js), after `await this.openInBackground(file);` the cache is already invalidated by `openInBackground`; no change needed.

- [ ] **Step 6: Run to verify** — `node --test --test-concurrency=1 test/app.test.js test/workbench.test.js` → all pass.

- [ ] **Step 7: Commit** — `git add src/app.js src/index.js test/fake-app.mjs test/app.test.js && git commit -m "perf: fresh window list, cached active document, fresh reads where writes depend on it"`

---

### Task 4: Pool flushes the saver before closing

**Files:** Modify `src/pool.js`

- [ ] **Step 1: Accept a saver** — change the `SessionPool` constructor signature to `constructor({ saver } = {})` and add `this.saver = saver;` as its first line.

- [ ] **Step 2: Flush before close** — in `close(file, { save = true } = {})`, replace:

```js
    const session = this.sessions.get(file);
    if (!session) return false;
    this.sessions.delete(file);
    try {
      if (save && session.dirty) await this.save(session);
```

with:

```js
    const session = this.sessions.get(file);
    if (!session) return false;
    if (save) await this.saver?.flush(file).catch(() => {}); // a failed save is kept by the saver
    this.sessions.delete(file);
    try {
      if (save && session.dirty) await this.save(session);
```

- [ ] **Step 3: Run existing tests** — `node --test test/pool.test.js` → pass (no saver injected yet, `?.` makes it a no-op).

- [ ] **Step 4: Commit** — `git add src/pool.js && git commit -m "feat: pool flushes pending background saves before closing a file"`

---

### Task 5: Background saves in the server

**Files:** Modify `src/index.js`; modify `test/app.test.js`, `test/server.test.js`, `test/multi-agent.test.js`

- [ ] **Step 1: Write the failing tests** — append to `test/app.test.js`:

```js
test("writes respond before saving; a burst saves once; save flushes and waits", async () => {
  const quick = await agent(withApp({ PEN_MULTI_SAVE_DELAY_MS: "5000" })); // longer than the burst
  const before = mtime(live);
  for (let i = 0; i < 5; i++) {
    const res = await call(quick, "execute", { filePath: live, input: `burst-${i}` });
    assert.match(text(res), /Saving to disk in the background/);
  }
  assert.equal(mtime(live), before, "not saved before responding");
  const saved = await call(quick, "save", { filePath: live });
  assert.ok(!saved.isError, text(saved));
  assert.ok(mtime(live) > before, "save flushed it");
});

test("a failed background save is reported on the next call for that file and in list_sessions", async () => {
  const broken = await agent(withApp({ PEN_MULTI_SAVE_DELAY_MS: "50", FAKE_SAVE_NOOP: "1" }));
  await call(broken, "execute", { filePath: live, input: "unsaved" });
  await new Promise((r) => setTimeout(r, 2500)); // the fake CLI save runs and fails the mtime check
  const next = await call(broken, "execute", { filePath: live, input: "next" });
  assert.match(text(next), /WARNING: .*not.*disk/i);
  const list = JSON.parse(text(await call(broken, "list_sessions", {})));
  assert.ok(list.saveErrors[live], JSON.stringify(list.saveErrors));
});

test("list_sessions reports timings", async () => {
  await call(s, "execute", { filePath: live, input: "t" });
  const list = JSON.parse(text(await call(s, "list_sessions", {})));
  assert.ok(list.timings.route && list.timings.call, JSON.stringify(list.timings));
});
```

Remove the old test `"a save the app did not perform is reported, not claimed"` (superseded by the test above), and in test `"the app's active document is edited in the app and saved to disk"` replace the two assertions

```js
  assert.match(text(res), /Saved to disk/);
  assert.ok(mtime(live) > before, "written to disk");
```

with

```js
  assert.match(text(res), /Saving to disk in the background/);
  await call(s, "save", { filePath: live });
  assert.ok(mtime(live) > before, "written to disk");
```

In `test/server.test.js`, test `"edits two files in parallel..."`, before the two `fs.statSync(...).size > 0` assertions add:

```js
  await Promise.all([fileA, fileB].map((filePath) => call(client, "save", { filePath })));
```

In `test/multi-agent.test.js`, test `"an agent that dies does not block others from its files"`, before `process.kill(doomed.pid, "SIGKILL");` add:

```js
  assert.ok(!(await call(doomed, "save", { filePath: file })).isError, "saved before the crash");
```

- [ ] **Step 2: Run to verify they fail** — `node --test --test-concurrency=1 test/app.test.js` → the three new tests fail.

- [ ] **Step 3: Implement in `src/index.js`**

Imports — add:

```js
import { SaveScheduler } from "./saver.js";
import { Timings } from "./timing.js";
```

Replace `const pool = new SessionPool();` with:

```js
const timings = new Timings();
const saver = new SaveScheduler({
  delayMs: Number(process.env.PEN_MULTI_SAVE_DELAY_MS ?? 1500),
  onError: (file, err) => process.stderr.write(`pen-multi: background save of ${file} failed: ${err.message}\n`),
});
const pool = new SessionPool({ saver });
```

Add helpers after `fail`:

```js
const SAVING_NOTE = "Saving to disk in the background; call save before reading or committing this file.";
const saveWarning = (file) => (saver.error(file) ? [`the last background save of this file failed: ${saver.error(file)}`] : []);

/** Schedules a background save of a headless session. */
const scheduleHeadlessSave = (session) =>
  saver.markDirty(session.file, () => timings.time("save", () => (session.dirty ? pool.save(session) : undefined)));

/** Schedules a background save of an app document. */
const scheduleAppSave = (file) => saver.markDirty(file, () => timings.time("save", () => app.save(file)));
```

Replace `appWrite` with:

```js
/** Runs a document-changing app call, then schedules a background save when autosave is on. */
async function appWrite(target, name, args, send = (t, a) => app.call(name, { filePath: t.file, ...a })) {
  const warnings = saveWarning(target.file);
  const res = await timings.time("call", () => send(target, args));
  if (res.isError) return fromApp(res, target);
  if (!config.autosave) return fromApp(res, target, "Not saved to disk (autosave is off): call save.");
  scheduleAppSave(target.file);
  return fromApp(res, target, [...warnings.map((w) => `WARNING: ${w}`), SAVING_NOTE].join("\n"));
}
```

Wrap routing time: rename the existing `route` function to `routeUntimed` and add below it:

```js
const route = (f, opts) => timings.time("route", () => routeUntimed(f, opts));
```

In the headless branch of the `execute` handler replace:

```js
      const res = await session.shell.call("execute", payload);
      if (res.error) return fail(res.error, file);
      session.dirty = true;
      if (config.autosave) await pool.save(session);
      return ok(res.text, warnings, file);
```

with:

```js
      const res = await timings.time("call", () => session.shell.call("execute", payload));
      if (res.error) return fail(res.error, file);
      session.dirty = true;
      const notes = [...warnings, ...saveWarning(file)];
      if (config.autosave) scheduleHeadlessSave(session);
      return ok(`${res.text}\n\n${config.autosave ? SAVING_NOTE : "Not saved to disk (autosave is off): call save."}`, notes, file);
```

In `place()` headless branch replace:

```js
    session.dirty = true;
    if (config.autosave) await pool.save(session);
    return ok(describe(res.text), warnings, dest.file);
```

with:

```js
    session.dirty = true;
    if (config.autosave) scheduleHeadlessSave(session);
    return ok(`${describe(res.text)}\n\n${SAVING_NOTE}`, warnings, dest.file);
```

In `place()` app branch, the note is the last content item already produced by `appWrite`; no change.

`save` tool — replace its handler body with:

```js
    const file = normalize(f);
    if (pool.sessions.has(file)) {
      await saver.flush(file).catch(() => {});
      return pool.use(file, async (session) => ok(await pool.save(session), saveWarning(file), file));
    }
    if ((await app.openFiles({ fresh: true })).has(file)) {
      await saver.flush(file).catch(() => {});
      await app.save(file);
      return ok(`Saved ${file} from the pen.dev app.`, [], file);
    }
    throw new Error(`${file} is not open here or in the pen.dev app.`);
```

and change its description to `"Write a .pen document to disk now, whether it is open headlessly or in the pen.dev app, waiting for any background save. Call it before reading or committing a .pen file."`.

`fork_version` — replace `if (pool.sessions.get(src)?.dirty) await pool.use(src, (s) => pool.save(s));` with:

```js
    await saver.flush(src).catch(() => {});
    if (pool.sessions.get(src)?.dirty) await pool.use(src, (s) => pool.save(s));
```

`list_sessions` — add to the returned JSON object: `timings: timings.summary(), pendingSaves: saver.pending(), saveErrors: saver.errors()`, and use `openFiles()` (cached) for `openDocuments` as today.

`shutdown()` — replace `await Promise.allSettled([pool.closeAll(), app.close()]);` with:

```js
  await saver.flushAll();
  await Promise.allSettled([pool.closeAll(), app.close()]);
```

Instructions — replace the autosave bullet `- ${config.autosave ? "Every successful change is saved to disk automatically, ..." : "..."}` with:

```js
- ${config.autosave ? "Every successful change is saved to disk automatically, in the background right after the call returns (in the app too, which also saves the user's own unsaved edits in that document). Call save before reading a .pen file from disk or committing it: it waits for the background save." : "Changes are not saved automatically: call save."}
```

- [ ] **Step 4: Run to verify** — `npm test` → all pass.

- [ ] **Step 5: Commit** — `git add src/index.js test/app.test.js test/server.test.js test/multi-agent.test.js && git commit -m "perf: save in the background after responding; flush where the disk must be current"`

---

### Task 6: Docs, version, benchmark

**Files:** Modify `README.md`, `package.json`, `src/index.js` (server version), `src/app.js` (client version)

- [ ] **Step 1: README** — in "Behaviour", replace the Autosave bullet with:

```markdown
- **Autosave**: every successful change is saved in the background right after the call returns (`PEN_MULTI_SAVE_DELAY_MS`, default 1500 ms of no further writes; bursts coalesce into one save). `save`, `close_file`, `fork_version`, eviction and shutdown flush first. Call `save` before reading a `.pen` from disk or committing it. A failed save is reported on the next call for that file and in `list_sessions`.
- **App state**: the list of app windows is read on every call; the app's active document is cached for `PEN_MULTI_APP_STATE_TTL_MS` (2000 ms) and re-read whenever a write depends on it.
```

and add to the env table:

```markdown
| `PEN_MULTI_SAVE_DELAY_MS` | `1500` | Idle time before a background save |
| `PEN_MULTI_APP_STATE_TTL_MS` | `2000` | How long the app's active document is cached |
```

- [ ] **Step 2: Version** — `sed -i '' 's/"version": "0.4.0"/"version": "0.5.0"/' package.json` and replace `version: "0.4.0"` with `version: "0.5.0"` in `src/index.js` and `src/app.js`.

- [ ] **Step 3: Full suite** — `npm test` → all pass; `pgrep -fl "dist/index.mjs interactive"` → nothing.

- [ ] **Step 4: Benchmark against the real app** (scratch document open in Pen; read-only snippet plus one write to the scratch file): run 10 `execute` calls through the MCP server and print median latency; record before (git stash of src) and after. Expected: app-routed median ≤ 600 ms on a lightly loaded machine.

- [ ] **Step 5: Commit and push** — `git add -A && git commit -m "docs: background saves and cached app state; 0.5.0" && git push`
