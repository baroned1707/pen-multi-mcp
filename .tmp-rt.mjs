import path from "node:path";
import { call, connect, text } from "./test/helpers.js";
import { loadApp, makeWorkspace, removeWorkspace, startApp } from "./bench/eval/real/workspace.mjs";
const ws = await makeWorkspace(loadApp("trading-agent"));
const stop = await startApp(ws);
try {
  const c = await connect({ home: path.join(ws.dir, ".h"), cwd: ws.dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" } });
  const url = new URL(ws.routes["Phiên Mỹ đang mở"], ws.baseUrl + "/").href;
  const res = text(await call(c, "import_ui", { filePath: ws.pen, source: { kind: "web", url }, name: "Q" }));
  console.log(res.split("\n").slice(1, 8).join("\n"));
  const id = /"Q" \((\S+)\)/.exec(res)[1];
  const v = text(await call(c, "verify", { filePath: ws.pen, target: id, source: { kind: "web", url }, crops: 0 }));
  console.log(v.split("\n").filter((l) => /^\d+\. \[(high|medium)\]|Viewport|Verdict/.test(l)).join("\n"));
  await c.close();
} finally { stop(); removeWorkspace(ws); }
