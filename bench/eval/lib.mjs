// Eval workspaces: a .pen made by import_ui from the task's fixture page, the code the agent
// starts from, and the check (verify run by the harness itself, not by the agent).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { call, connect, text } from "../../test/helpers.js";
import { TASKS, fixture } from "./tasks.mjs";

export async function workspace(task, server) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pen-eval-${task}-`)));
  const pen = path.join(dir, "design.pen");
  const page = path.join(dir, "page.html");
  fs.copyFileSync(fixture(TASKS[task].design), path.join(dir, "source.html"));
  const c = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" }, server });
  const res = await call(c, "import_ui", { filePath: pen, source: { kind: "web", url: `file://${path.join(dir, "source.html")}` }, name: "Profile" });
  if (res.isError) throw new Error(text(res));
  await call(c, "save", { filePath: pen });
  await c.close();
  fs.rmSync(path.join(dir, "source.html"));
  fs.writeFileSync(page, TASKS[task].code());
  return { dir, pen, page };
}

export async function check(w, server) {
  const c = await connect({ home: path.join(w.dir, "home-check"), cwd: w.dir, env: { PEN_MULTI_PREWARM: "0" }, server });
  try {
    const t = text(await call(c, "verify", { filePath: w.pen, target: "Profile", source: { kind: "web", url: `file://${w.page}` } }));
    return { match: /Verdict: MATCH/.test(t), summary: /Verdict: .*/.exec(t)?.[0] };
  } finally {
    await c.close();
  }
}

