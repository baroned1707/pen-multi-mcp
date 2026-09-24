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
  const res = await call(s, "execute", { filePath: live, input: "x" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /File: .*live\.pen \(in the pen\.dev desktop app\)/);
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${live} input=x`));
  assert.match(text(res), /Saved to disk/);
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

test("browser read actions work on a headless file without opening it in the app", async () => {
  const file = doc("reads.pen");
  const res = await call(s, "browser", { filePath: file, action: "return-screenshot", url: "https://a.example" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /action=return-screenshot page=https:\/\/a\.example/, "loaded and read in one step");
  assert.ok(!appState().open.includes(file), "not opened in the app");
});

test("import-to-canvas opens a headless file in the app in the background, then imports and saves", async () => {
  const file = doc("import.pen");
  await call(s, "execute", { filePath: file, input: "headless-first" }); // held by a headless editor here
  const res = await call(s, "browser", { filePath: file, action: "import-to-canvas", url: "https://b.example" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /import\.pen \(in the pen\.dev desktop app, opened in the background\)/);
  assert.match(text(res), new RegExp(`APP-BROWSER doc=${file} action=import-to-canvas page=https://b.example`));
  assert.match(text(res), /Saved to disk/);
  const list = JSON.parse(text(await call(s, "list_sessions", {})));
  assert.ok(!list.sessions.some((x) => x.filePath === file), "the headless editor handed the file over");
});

test("spawn_agents opens a file in the app when needed and works there", async () => {
  const file = doc("spawn.pen");
  const res = await call(s, "spawn_agents", { filePath: file, config: [{ prompt: "p", containerNodes: ["n1"] }] });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), new RegExp(`APP-SPAWN doc=${file} agents=1`));
  assert.ok(fs.existsSync(file), "a new file is created before the app opens it");
});

test("a file another agent edits headlessly is not pulled into the app", async () => {
  const file = doc("held.pen");
  const other = await agent({ ...withApp(), PEN_MULTI_APP: "0" });
  assert.ok(!(await call(other, "execute", { filePath: file, input: "mine" })).isError);
  const res = await call(s, "browser", { filePath: file, action: "import-to-canvas" });
  assert.equal(res.isError, true);
  assert.match(text(res), /being edited by another agent/);
  assert.ok(!appState().open.includes(file));
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

test("a save the app did not perform is reported, not claimed", async () => {
  const quiet = await agent(withApp({ FAKE_SAVE_NOOP: "1" }));
  const res = await call(quiet, "execute", { filePath: live, input: "unsaved" });
  assert.match(text(res), /not on disk/);
  assert.doesNotMatch(text(res), /Saved to disk/);
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
  const sp = await call(noApp, "spawn_agents", { filePath: live, config: [{ prompt: "p", containerNodes: ["n"] }] });
  assert.equal(sp.isError, true);
  assert.match(text(sp), /your own subagents/);
  const e = await call(noApp, "execute", { input: "x" });
  assert.match(text(e), /Pass filePath/);
  assert.ok(!(await call(noApp, "execute", { filePath: doc("solo.pen"), input: "fine" })).isError);
});
