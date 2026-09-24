// Browser canvas actions run in the workbench and their layers are moved into the destination.
// The documents are real (see fake-app-engine.mjs), so the move is checked on the real engine.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, connect, text } from "./helpers.js";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-bench-")));
const stateFile = path.join(root, "app-state.json");
const doc = (name) => path.join(root, name);
const benchDir = path.join(root, "bench");
const workbench = path.join(benchDir, "workbench.pen");
const userDoc = doc("user.pen"); // open in the (fake) app

let s;
before(async () => {
  fs.writeFileSync(stateFile, JSON.stringify({ active: userDoc, open: [userDoc], page: "" }));
  s = await connect({
    home: path.join(root, "home"),
    cwd: root,
    env: {
      PEN_MULTI_APP: "1",
      PEN_MULTI_APP_SERVER: here("./fake-app-engine.mjs"),
      PEN_MULTI_APP_SOCKET: "none",
      PEN_MULTI_APP_DOCS_FILE: stateFile,
      PEN_MULTI_APP_OPEN_CMD: JSON.stringify([here("./fake-open.mjs"), stateFile]),
      PEN_MULTI_APP_UI: "0",
      PEN_MULTI_WORKBENCH: workbench,
      // App-mode saves would go through the real CLI to the real pen.dev app; keep them off.
      PEN_MULTI_AUTOSAVE: "0",
      FAKE_ACTIVE_FILE: stateFile,
    },
  });
});
after(async () => {
  await s?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const tree = `const out=[];Get((n,c)=>{out.push("  ".repeat(c.depth)+n.name);return undefined});Print("TREE",JSON.stringify(out))`;
const treeOf = async (filePath) => JSON.parse(/^TREE (.*)$/m.exec(text(await call(s, "execute", { filePath, input: tree })))[1]);

test("import-to-canvas into a headless file moves the whole layer tree there and leaves the workbench clean", async () => {
  const dest = doc("headless.pen");
  const res = await call(s, "browser", { filePath: dest, action: "import-to-canvas", url: "https://site.example" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), new RegExp(`Moved into ${dest} as: "\\w+" \\(Imported site\\.example\\)`));
  assert.deepEqual(await treeOf(dest), ["Imported site.example", "  Heading", "  Row", "    Cell"]);
  assert.deepEqual(await treeOf(workbench), [], "nothing left behind in the workbench");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(!state.open.includes(dest), "the destination was never opened in the app");
  const noPath = await call(s, "execute", { input: 'Print("where")' });
  assert.match(text(noPath), /File: .*user\.pen/, "calls without filePath still go to the user's document");
});

test("screenshot-to-canvas carries its image file next to the destination", async () => {
  const dest = path.join(root, "other-dir", "shots.pen");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await call(s, "browser", { filePath: dest, action: "screenshot-to-canvas", url: "https://pics.example" });
  assert.ok(!res.isError, text(res));
  assert.ok(fs.existsSync(path.join(path.dirname(dest), "screenshot-pics.example.png")), "image copied next to the destination");
  const fill = /^FILL (.*)$/m.exec(
    text(await call(s, "execute", { filePath: dest, input: `Get(n=>{if(n.name==="Screenshot")Print("FILL",JSON.stringify(n.fill));return undefined})` })),
  )[1];
  assert.match(fill, /"url":"screenshot-pics\.example\.png"/);
});

test("import-to-canvas into a document open in the app lands in that document", async () => {
  const res = await call(s, "browser", { filePath: userDoc, action: "import-to-canvas", url: "https://live.example" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /File: .*user\.pen \(in the pen\.dev desktop app\)/);
  assert.deepEqual(await treeOf(userDoc), ["Imported live.example", "  Heading", "  Row", "    Cell"]);
});
