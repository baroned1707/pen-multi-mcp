// Routing between headless editors and the pen.dev desktop app, with a fake CLI and a fake app.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, connect, text } from "./helpers.js";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-app-")));
const stateFile = path.join(root, "app-state.json");
const live = path.join(root, "live.pen");
const other = path.join(root, "other.pen");
const setApp = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));

const withApp = {
  PEN_CLI_PATH: here("./fake-cli.mjs"),
  PEN_MULTI_APP: "1",
  PEN_MULTI_APP_SERVER: here("./fake-app.mjs"), // executable; ignores the pen flags it is given
  PEN_MULTI_APP_SOCKET: "none",
  FAKE_ACTIVE_FILE: stateFile,
};

let s;
before(async () => {
  setApp({ active: live, open: [live] });
  s = await connect({ home: path.join(root, "home"), cwd: root, env: withApp });
});
after(async () => {
  await s?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the app's active document is edited live in the app", async () => {
  const res = await call(s, "execute", { filePath: live, input: "x" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /File: .*live\.pen \(live in the pen\.dev desktop app\)/);
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${live} input=x`));
  assert.match(text(res), /Cmd\+S/);
});

test("omitting filePath targets the app's active document, like the official server", async () => {
  const res = await call(s, "execute", { input: "y" });
  assert.match(text(res), new RegExp(`APP-EXECUTE doc=${live} input=y`));
  const state = await call(s, "get_app_state", {});
  assert.match(text(state), /Selected nodes/);
});

test("a failing snippet in the app comes back as an error result and the app stays usable", async () => {
  const bad = await call(s, "execute", { filePath: live, input: "FAIL" });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /editId`: "E1"/);
  assert.doesNotMatch(text(bad), /MCP error/);
  const good = await call(s, "execute", { filePath: live, input: "after-failure" });
  assert.ok(!good.isError, text(good));
  assert.match(text(good), /APP-EXECUTE .*after-failure/);
});

test("any other file runs headlessly and is never sent to the app", async () => {
  const res = await call(s, "execute", { filePath: other, input: "z" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /ECHO .*other\.pen/);
  assert.doesNotMatch(text(res), /APP-/);
});

test("browser and spawn_agents go to the app's active document", async () => {
  const b = await call(s, "browser", { action: "load-page", url: "https://example.com" });
  assert.match(text(b), new RegExp(`APP-BROWSER doc=${live} action=load-page url=https://example.com`));
  const sp = await call(s, "spawn_agents", { filePath: live, config: [{ prompt: "p", containerNodes: ["n1"] }] });
  assert.match(text(sp), new RegExp(`APP-SPAWN doc=${live} agents=1`));
});

test("browser on a file that is not the app's active tab is refused, not misrouted", async () => {
  const res = await call(s, "browser", { filePath: other, action: "import-to-canvas" });
  assert.equal(res.isError, true);
  assert.match(text(res), /active tab is .*live\.pen/);
});

test("a file open headlessly that becomes the app's active tab is refused instead of overwritten", async () => {
  await call(s, "execute", { filePath: other, input: "open-it" }); // headless session on other.pen
  setApp({ active: other, open: [live, other] });
  try {
    const res = await call(s, "execute", { filePath: other, input: "clash" });
    assert.equal(res.isError, true);
    assert.match(text(res), /open both headlessly here and as the active tab/);

    await call(s, "close_file", { filePath: other });
    const after = await call(s, "execute", { filePath: other, input: "now-live" });
    assert.match(text(after), new RegExp(`APP-EXECUTE doc=${other} input=now-live`));
  } finally {
    setApp({ active: live, open: [live] });
  }
});

test("get_style passes params through", async () => {
  const res = await call(s, "get_style", { name: "Aerial Gravitas", params: { accent: "blue" } });
  assert.match(text(res), /get_style\(\{"name":"Aerial Gravitas","params":\{"accent":"blue"\}\}\)/);
});

test("without the app, app-only tools explain what they need", async () => {
  const noApp = await connect({ home: path.join(root, "home2"), cwd: root, env: { PEN_CLI_PATH: here("./fake-cli.mjs") } });
  try {
    const b = await call(noApp, "browser", { action: "load-page", url: "https://example.com" });
    assert.equal(b.isError, true);
    assert.match(text(b), /needs the pen\.dev desktop app/);
    const e = await call(noApp, "execute", { input: "x" });
    assert.equal(e.isError, true);
    assert.match(text(e), /Pass filePath/);
    const h = await call(noApp, "execute", { filePath: other, input: "fine" });
    assert.ok(!h.isError, text(h));
  } finally {
    await noApp.close();
  }
});
