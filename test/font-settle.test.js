// A headless editor loads fonts asynchronously: the first measurement after opening a file must
// already be in the real fonts, not the fallback.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-fonts-")));
const file = path.join(dir, "f.pen");
const clients = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});
const open = async () => {
  const c = await connect({ home: path.join(dir, `h${clients.length}`), cwd: dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" } });
  clients.push(c);
  return c;
};
const titleSize = (t) => /Title \[text\] · (\S+) /.exec(t)?.[1];

test("inspect right after opening a file measures text in its real font", async () => {
  const a = await open();
  const made = text(await call(a, "execute", { filePath: file, input: `s = Insert(document, { type: "frame", name: "Home", width: 390, height: 200, layout: "vertical" }); Insert(s, { type: "text", name: "Title", content: "Bảng màu Header", fontFamily: "Inter", fontSize: 28, fontWeight: "700" }); Print("S", s);` }));
  const id = /S (\S+)/.exec(made)[1];
  await call(a, "save", { filePath: file });
  await a.close();
  clients.pop();
  const b = await open(); // a new process: a fresh headless editor, fonts not loaded yet
  const first = titleSize(text(await call(b, "inspect", { filePath: file, target: id, image: false, detail: "full" })));
  await new Promise((r) => setTimeout(r, 4000));
  const later = titleSize(text(await call(b, "inspect", { filePath: file, target: id, image: false, detail: "full" })));
  assert.ok(first && later, `${first} / ${later}`);
  assert.equal(first, later, "the first measurement already uses the loaded font");
});
