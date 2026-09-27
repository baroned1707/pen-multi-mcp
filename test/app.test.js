// Routing between headless editors and the pen.dev desktop app, with a fake CLI and a fake app
// that behave like the real ones where it matters (see fake-*.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, connect, text } from "./helpers.js";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-app-")));
const stateFile = path.join(root, "app-state.json");
const home = path.join(root, "home");
const doc = (name) => path.join(root, name);
const live = doc("live.pen"); // the app's active document
const workbench = doc("workbench.pen");
const background = doc("background.pen"); // open in a background window of the app
// `ready`: windows whose browser already answers (see fake-app.mjs); new windows start not ready.
const setApp = (state) => fs.writeFileSync(stateFile, JSON.stringify({ page: "", ready: [live, background], ...state }));
const appState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const mtime = (f) => fs.statSync(f).mtimeMs;

const withApp = (extra = {}) => ({
  PEN_CLI_PATH: here("./fake-cli.mjs"),
  PEN_MULTI_APP: "1",
  PEN_MULTI_APP_SERVER: here("./fake-app.mjs"), // executable; ignores the pen flags it is given
  PEN_MULTI_APP_SOCKET: "none",
  PEN_MULTI_APP_DOCS_FILE: stateFile,
  PEN_MULTI_APP_OPEN_CMD: JSON.stringify([here("./fake-open.mjs"), stateFile]),
  PEN_MULTI_APP_UI: "0",
  PEN_MULTI_WORKBENCH: workbench,
  FAKE_ACTIVE_FILE: stateFile,
  ...extra,
});

const agents = [];
const agent = async (env = withApp()) => {
  const c = await connect({ home, cwd: root, env });
  agents.push(c);
  return c;
};

let s;
before(async () => {
  for (const f of [live, background]) fs.writeFileSync(f, "x");
  setApp({ active: live, open: [live, background] });
  s = await agent();
});
beforeEach(() => setApp({ active: live, open: [live, background] }));
after(async () => {
  await Promise.allSettled(agents.map((a) => a.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the app's active document is edited in the app and saved to disk", async () => {
  const before = mtime(live);
  const res = await call(s, "execute", { filePath: live, input: 'Update("n",{name:"x"})' });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /File: .*live\.pen \(in the pen\.dev desktop app\)/);
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${live} input=Update.*"x"`));
  assert.match(text(res), /Saving to disk in the background/);
  await call(s, "save", { filePath: live });
  assert.ok(mtime(live) > before, "written to disk");
});

test("an agent's very first app call works, though the app fails the first call of a connection", async () => {
  const fresh = await agent();
  const res = await call(fresh, "execute", { input: "first" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${live} input=first`));
});

test("a document open in a background window goes to the app too, not to a headless copy", async () => {
  const res = await call(s, "execute", { filePath: background, input: "bg" });
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${background} input=bg`));
  assert.equal(appState().active, live, "the user's active window is left alone");
});

test("get_app_state on a document open in a background window describes that document, not the active one", async () => {
  const res = await call(s, "get_app_state", { filePath: background });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /File: .*background\.pen/);
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${background}`), "read from the background document itself");
  assert.doesNotMatch(text(res), /Currently active canvas editor/, "not the active document's state");
  assert.match(text(res), /only reported for the app's active document/);
});

test("get_app_state on the active document keeps the app's own report, selection included", async () => {
  const res = await call(s, "get_app_state", { filePath: live });
  assert.match(text(res), new RegExp(`Currently active canvas editor: \`${live}\``));
  assert.match(text(res), /Selected nodes/);
});

test("omitting filePath targets the app's active document, like the official server", async () => {
  assert.match(text(await call(s, "execute", { input: "y" })), new RegExp(`APP-EXECUTE doc=${live} input=y`));
  assert.match(text(await call(s, "get_app_state", {})), /Selected nodes/);
});

test("a file the app does not have open runs headlessly and is never sent to the app", async () => {
  const res = await call(s, "execute", { filePath: doc("plain.pen"), input: "z" });
  assert.match(text(res), /ECHO .*plain\.pen/);
  assert.doesNotMatch(text(res), /APP-/);
  assert.ok(!appState().open.includes(doc("plain.pen")));
});

test("a failing snippet in the app comes back as an error result and the app stays usable", async () => {
  const bad = await call(s, "execute", { filePath: live, input: "FAIL" });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /editId`: "E1"/);
  assert.doesNotMatch(text(bad), /MCP error/);
  assert.match(text(await call(s, "execute", { filePath: live, input: "after" })), /APP-EXECUTE .*after/);
});

test("browser runs in the workbench: the user's file is never opened and their active window is kept", async () => {
  const file = doc("reads.pen");
  const res = await call(s, "browser", { filePath: file, action: "return-screenshot", url: "https://a.example" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /pen-multi workbench/);
  assert.match(text(res), new RegExp(`APP-BROWSER doc=${workbench} action=return-screenshot page=https://a.example`));
  assert.ok(!appState().open.includes(file), "the user's file was not opened");
  assert.equal(appState().active, workbench, "opening the workbench made it the app's active window");
  assert.match(
    text(await call(s, "execute", { input: "still-mine" })),
    new RegExp(`APP-EXECUTE doc=${live}`),
    "calls without filePath still go to the user's document",
  );
});

test("spawn_agents on a file not open in the app does not open it, and says what to do instead", async () => {
  const file = doc("spawn.pen");
  const res = await call(s, "spawn_agents", { filePath: file, config: [{ prompt: "p", containerNodes: ["n1"] }] });
  assert.equal(res.isError, true);
  assert.match(text(res), /never opens windows/);
  assert.match(text(res), /your own subagents/);
  assert.ok(!appState().open.includes(file));
});

test("spawn_agents on a document open in the app runs there", async () => {
  const res = await call(s, "spawn_agents", { filePath: background, config: [{ prompt: "p", containerNodes: ["n1"] }] });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), new RegExp(`APP-SPAWN doc=${background} agents=1`));
});

test("a file another agent edits headlessly is not also edited through the app", async () => {
  const file = doc("held.pen");
  const other = await agent({ ...withApp(), PEN_MULTI_APP: "0" });
  assert.ok(!(await call(other, "execute", { filePath: file, input: "mine" })).isError);
  setApp({ active: live, open: [live, background, file] }); // the user opens it in the app too
  const res = await call(s, "execute", { filePath: file, input: "theirs" });
  assert.equal(res.isError, true);
  assert.match(text(res), /being edited by another agent/);
});

test("a file open both headlessly here and in the app is refused instead of overwritten", async () => {
  const file = doc("clash.pen");
  await call(s, "execute", { filePath: file, input: "open-it" });
  setApp({ active: live, open: [live, background, file] }); // the user opens it in the app
  const res = await call(s, "execute", { filePath: file, input: "clash" });
  assert.equal(res.isError, true);
  assert.match(text(res), /open both headlessly here and in the pen\.dev app/);
  await call(s, "close_file", { filePath: file });
  assert.match(text(await call(s, "execute", { filePath: file, input: "now-app" })), /APP-EXECUTE .*now-app/);
});

test("agents take turns on the shared browser, so a load and a read are never split", async () => {
  const env = withApp({ FAKE_LOAD_MS: "1500" });
  const [a, b] = await Promise.all([agent(env), agent(env)]);
  await Promise.all([a, b].map((x) => call(x, "get_app_state", {}))); // both connected before the race
  const [ra, rb] = await Promise.all([
    call(a, "browser", { action: "return-element", url: "https://one.example" }),
    call(b, "browser", { action: "return-element", url: "https://two.example" }),
  ]);
  assert.match(text(ra), /page=https:\/\/one\.example/);
  assert.match(text(rb), /page=https:\/\/two\.example/);
});

test("an agent never mistakes the workbench for the user's document", async () => {
  fs.rmSync(`${workbench}.user-active`, { force: true }); // nothing remembered
  setApp({ active: workbench, open: [live, background, workbench] });
  const res = await call(s, "execute", { input: "where" });
  assert.equal(res.isError, true);
  assert.match(text(res), /workbench, not a design/);
});

test("get_style passes params through", async () => {
  const res = await call(s, "get_style", { name: "Aerial Gravitas", params: { accent: "blue" } });
  assert.match(text(res), /get_style\(\{"name":"Aerial Gravitas","params":\{"accent":"blue"\}\}\)/);
});

test("without the app, app-only tools explain what to do instead", async () => {
  const noApp = await connect({ home: path.join(root, "home-noapp"), cwd: root, env: { PEN_CLI_PATH: here("./fake-cli.mjs") } });
  agents.push(noApp);
  const b = await call(noApp, "browser", { action: "load-page", url: "https://example.com" });
  assert.equal(b.isError, true);
  assert.match(text(b), /needs the pen\.dev desktop app/);
  const imp = await call(noApp, "browser", { filePath: doc("solo.pen"), action: "import-to-canvas", url: "https://example.com" });
  assert.equal(imp.isError, true);
  const sp = await call(noApp, "spawn_agents", { filePath: live, config: [{ prompt: "p", containerNodes: ["n"] }] });
  assert.equal(sp.isError, true);
  assert.match(text(sp), /your own subagents/);
  const e = await call(noApp, "execute", { input: "x" });
  assert.match(text(e), /Pass filePath/);
  assert.ok(!(await call(noApp, "execute", { filePath: doc("solo.pen"), input: "fine" })).isError);
});

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
  const res = await call(s, "execute", { input: 'Update("n",{name:"no-path"})' });
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${background} input=Update.*no-path`));
});

test("a dashboard-opened document that was closed does not receive the write", async () => {
  const dash = doc("dashboard.pen"); // active, but not in the window list
  setApp({ active: dash, open: [live] });
  const a = await agent(withApp({ PEN_MULTI_APP_STATE_TTL_MS: "60000" })); // its first lookup caches dash
  assert.match(text(await call(a, "get_app_state", {})), /File: .*dashboard\.pen/);
  setApp({ active: live, open: [live] }); // the user closes it
  const res = await call(a, "execute", { filePath: dash, input: 'Update("n",{name:"w"})' });
  assert.doesNotMatch(text(res), /APP-EXECUTE/, "not sent to the app, where it would land in live.pen");
  await call(a, "close_file", { filePath: dash });
});

test("reads reuse the cached active document; concurrent calls share one request", async () => {
  const fresh = await agent(withApp({ PEN_MULTI_APP_STATE_TTL_MS: "60000" }));
  await call(fresh, "get_app_state", {});
  const before = appState().stateCalls ?? 0;
  await Promise.all([1, 2, 3, 4].map(() => call(fresh, "get_app_state", { filePath: live })));
  assert.equal((appState().stateCalls ?? 0) - before, 4, "one proxied report per call, no extra active lookups");
  const reads = appState().stateCalls ?? 0;
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

test("writes respond before saving; a burst saves once; save flushes and waits", async () => {
  const quick = await agent(withApp({ PEN_MULTI_SAVE_DELAY_MS: "5000" })); // longer than the burst
  const before = mtime(live);
  for (let i = 0; i < 5; i++) {
    const res = await call(quick, "execute", { filePath: live, input: `Update("n",{name:"burst-${i}"})` });
    assert.match(text(res), /Saving to disk in the background/);
  }
  assert.equal(mtime(live), before, "not saved before responding");
  const saved = await call(quick, "save", { filePath: live });
  assert.ok(!saved.isError, text(saved));
  assert.ok(mtime(live) > before, "save flushed it");
});

test("a failed background save is reported on the next call for that file and in list_sessions", async () => {
  const broken = await agent(withApp({ PEN_MULTI_SAVE_DELAY_MS: "50", FAKE_SAVE_NOOP: "1" }));
  await call(broken, "execute", { filePath: live, input: 'Update("n",{name:"unsaved"})' });
  await new Promise((r) => setTimeout(r, 2500)); // the fake CLI save runs and fails the mtime check
  const next = await call(broken, "execute", { filePath: live, input: 'Update("n",{name:"next"})' });
  assert.match(text(next), /WARNING: .*not.*disk/i);
  const list = JSON.parse(text(await call(broken, "list_sessions", {})));
  assert.ok(list.saveErrors[live], JSON.stringify(list.saveErrors));
});

test("list_sessions reports timings", async () => {
  await call(s, "execute", { filePath: live, input: "t" });
  const list = JSON.parse(text(await call(s, "list_sessions", {})));
  assert.ok(list.timings.route && list.timings.call, JSON.stringify(list.timings));
});

test("a read-only snippet on an app document is not saved and does not claim a save", async () => {
  const before = mtime(live);
  const res = await call(s, "execute", { filePath: live, input: 'Print(Get("n"))' });
  assert.doesNotMatch(text(res), /Saving to disk/);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(mtime(live), before, "nothing written for a read");
});
