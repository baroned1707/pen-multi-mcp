// The frames of a real app that verify as MATCH on its pristine state — the only ones a mutation
// task can start from. Cached per app commit.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { call, connect, text } from "../../../test/helpers.js";

export async function baseline(ws, { server, log = () => {} } = {}) {
  const commit = execFileSync("git", ["-C", ws.dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const cache = new URL(`../apps/.baseline-${ws.app.name}-${commit}.json`, import.meta.url);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const c = await connect({ home: path.join(ws.dir, ".home-baseline"), cwd: ws.dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" }, server });
  const frames = [];
  try {
    for (const name of Object.keys(ws.routes)) {
      const t = text(await call(c, "verify", { filePath: ws.pen, target: name, source: { kind: "web" }, crops: 0 }));
      const m = /^# verify: .* \((\S+)\) vs/m.exec(t);
      const match = /Verdict: MATCH/.test(t);
      log(`${match ? "MATCH " : "differs"} ${name}`);
      if (m && match) frames.push({ name, id: m[1] });
    }
  } finally {
    await c.close();
  }
  const out = { app: ws.app.name, commit, frames };
  fs.writeFileSync(cache, `${JSON.stringify(out, null, 1)}\n`);
  return out;
}
