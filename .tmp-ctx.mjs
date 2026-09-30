import path from "node:path";
import { call, connect, text } from "./test/helpers.js";
import { loadApp, makeWorkspace, removeWorkspace, startApp } from "./bench/eval/real/workspace.mjs";
const ws = await makeWorkspace(loadApp("trading-agent"));
const stop = await startApp(ws);
const out = (title, t) => console.log(`\n===== ${title}\n${t.split("\n").filter((l) => !l.startsWith("File:")).join("\n")}`);
try {
  const c = await connect({ home: path.join(ws.dir, ".h"), cwd: ws.dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" } });
  out("doctor", text(await call(c, "doctor", { filePath: ws.pen })));
  const ov = text(await call(c, "overview", { filePath: ws.pen }));
  out("overview (head)", ov.split("\n").slice(0, 8).join("\n") + "\n…\n" + ov.split("\n").filter((l) => /^## (Components|Type|Spacing|Fills)|⚠/.test(l)).join("\n"));
  const ins = text(await call(c, "inspect", { filePath: ws.pen, target: "Vị thế", image: false, maxLines: 40 }));
  out("inspect Vị thế (head + code section)", ins.split("\n").slice(0, 45).join("\n"));
  const ss = text(await call(c, "sync_status", { filePath: ws.pen, maxLines: 12 }));
  out("sync_status (head)", ss.split("\n").slice(0, 20).join("\n"));
  await c.close();
} finally { stop(); removeWorkspace(ws); }
