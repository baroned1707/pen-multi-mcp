// Eval workspaces: a .pen made by import_ui from the task's fixture page, the code the agent
// starts from, and the check (verify run by the harness itself, not by the agent).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { call, connect, text } from "../../test/helpers.js";

// Records the "matched before" starting point: this checkout's server, whichever sides are compared.
const RECORDER = new URL("../../src/index.js", import.meta.url).pathname;
import { TASKS, fixture } from "./tasks.mjs";

export async function workspace(task, server) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pen-eval-${task}-`)));
  const pen = path.join(dir, "design.pen");
  const page = path.join(dir, "page.html");
  fs.copyFileSync(fixture(TASKS[task].design), path.join(dir, "source.html"));
  const c = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" }, server });
  const res = await call(c, "import_ui", { filePath: pen, source: { kind: "web", url: `file://${path.join(dir, "source.html")}` }, name: "Profile" });
  if (res.isError) throw new Error(text(res));
  // A task that starts from "they matched last week": a git repository with the MATCH recorded
  // (design-sync/, by this checkout's verify) and committed, before either side changes.
  if (TASKS[task].matchedBefore) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(page, fs.readFileSync(path.join(dir, "source.html"), "utf8"));
    const rc = await connect({ home: path.join(dir, "home-record"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" }, server: RECORDER });
    await call(c, "save", { filePath: pen });
    const v = text(await call(rc, "verify", { filePath: pen, target: "Profile", source: { kind: "web", url: `file://${page}` }, crops: 0 }));
    await rc.close();
    if (!/Verdict: MATCH/.test(v)) throw new Error(`the starting point did not match: ${v.slice(0, 300)}`);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-q", "-m", "matched"], { cwd: dir });
  }
  // A task may change the design after the import (e.g. both sides edited since they matched).
  if (TASKS[task].designEdit) {
    const id = /"Profile" \((\S+)\)/.exec(text(res))[1];
    const out = await call(c, "execute", { filePath: pen, input: TASKS[task].designEdit(id) });
    if (out.isError) throw new Error(text(out));
  }
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

