// How clean import_ui is on a real app: imports a few routed screens into a copy of the design
// and counts icons as icon nodes vs crops, layer names that are selectors, auto-layout frames, and
// whether the round trip verifies as MATCH. No agent involved.
// Usage: node bench/eval/real/import-quality.mjs [--app trading-agent] [--screens 4] [--components]
import path from "node:path";
import { call, connect, text } from "../../../test/helpers.js";
import { loadApp, makeWorkspace, removeWorkspace, startApp } from "./workspace.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const app = loadApp(opt("app", "trading-agent"));
const count = Number(opt("screens", 4));
const ws = await makeWorkspace(app);
const stop = await startApp(ws);
const rows = [];
try {
  const c = await connect({ home: path.join(ws.dir, ".home-q"), cwd: ws.dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" } });
  const names = Object.keys(ws.routes).filter((n, i, all) => all.indexOf(n) === i).slice(0, count);
  for (const name of names) {
    const url = new URL(ws.routes[name], ws.baseUrl + "/").href;
    const res = text(await call(c, "import_ui", { filePath: ws.pen, source: { kind: "web", url }, name: `Q ${name}`, components: argv.includes("--components") || undefined }));
    const id = /"Q [^"]*" \((\S+)\)/.exec(res)?.[1];
    if (!id) {
      rows.push({ name, error: res.slice(0, 200) });
      continue;
    }
    const stats = JSON.parse(/S (.*)/.exec(text(await call(c, "execute", { filePath: ws.pen, input: `const all = Get(${JSON.stringify(id)}, (n) => ({ type: n.type, name: n.name, layout: n.layout, fill: n.fill, reusable: n.reusable }));
Print("S", JSON.stringify({ nodes: all.length, icons: all.filter((n) => n.type === "icon").length, crops: all.filter((n) => n.fill && n.fill.type === "image").length, selectorNames: all.filter((n) => /nth-of-type|^(div|span|a|li|section)$|[>.#]/.test(n.name ?? "")).length, auto: all.filter((n) => n.type === "frame" && (n.layout === "vertical" || n.layout === "horizontal")).length, instances: all.filter((n) => n.type === "ref").length }));` })))[1]);
    const v = text(await call(c, "verify", { filePath: ws.pen, target: id, source: { kind: "web", url }, crops: 0 }));
    rows.push({ name, ...stats, match: /Verdict: MATCH/.test(v), verdict: /Verdict: [A-Z]+[^·]*/.exec(v)?.[0] });
    console.log(JSON.stringify(rows.at(-1)));
  }
  await c.close();
} finally {
  stop();
  removeWorkspace(ws);
}
const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
console.log(`TOTAL nodes ${sum("nodes")} · icons ${sum("icons")} · crops ${sum("crops")} · selector names ${sum("selectorNames")} · auto-layout frames ${sum("auto")} · instances ${sum("instances")} · round trip MATCH ${rows.filter((r) => r.match).length}/${rows.length}`);
