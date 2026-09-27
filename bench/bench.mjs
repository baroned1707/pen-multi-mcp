// Benchmarks pen-multi headless on copies of .pen files; the originals are never touched.
// Usage: npm run bench -- path/to/a.pen [path/to/b.pen ...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { call, connect, text } from "../test/helpers.js";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: npm run bench -- <file.pen> [more.pen ...]");
  process.exit(2);
}
const SOURCES = Object.fromEntries(args.map((p, i) => [`${i}:${path.basename(p, ".pen")}`, path.resolve(p)]));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-bench-")));
const home = path.join(root, "home");
const files = {};
for (const [k, src] of Object.entries(SOURCES)) {
  files[k] = path.join(root, `${k.replace(":", "-")}.pen`);
  fs.copyFileSync(src, files[k]);
  for (const img of fs.readdirSync(path.dirname(src))) if (/\.(png|jpe?g|webp|svg)$/i.test(img)) fs.copyFileSync(path.join(path.dirname(src), img), path.join(root, img));
}
// The copies share one directory, so the servers above never pre-warm; section 5 measures that.
const env = { PEN_MULTI_PREWARM: "0" };

const t = async (fn) => { const s = performance.now(); const r = await fn(); return [performance.now() - s, r]; };
const ms = (x) => `${Math.round(x)} ms`;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const must = (r) => { if (r.isError) throw new Error(text(r).slice(0, 300)); return r; };
const rows = [];

// 1. Single agent, each file in turn.
const c = await connect({ home, cwd: root, env });
for (const [k, f] of Object.entries(files)) {
  const [open] = await t(() => call(c, "execute", { filePath: f, input: `Print("n", Get((n,c)=>{c.skipChildren();return n.id}).length)` }).then(must));
  const reads = [];
  for (let i = 0; i < 5; i++) reads.push((await t(() => call(c, "execute", { filePath: f, input: `Print("n", Get((n,c)=>{c.skipChildren();return n.id}).length)` }).then(must)))[0]);
  const writes = [];
  for (let i = 0; i < 5; i++) writes.push((await t(() => call(c, "execute", { filePath: f, input: `Insert(document,{type:"rectangle",name:"bench${i}",x:-9000,y:${i * 50},width:40,height:40,fill:"#E5484D"})` }).then(must)))[0]);
  const [save] = await t(() => call(c, "save", { filePath: f }).then(must));
  const [ovCold, ov] = await t(() => call(c, "overview", { filePath: f, refresh: true }).then(must));
  const [ovWarm] = await t(() => call(c, "overview", { filePath: f }).then(must));
  const idRes = text(must(await call(c, "execute", { filePath: f, input: `Print("ID", JSON.stringify(Get((n,c)=>{c.skipChildren();return n.type==="frame"&&!n.reusable&&(n.width??0)>=300?n.id:undefined})))` })));
  const id = JSON.parse(/ID (.*)/.exec(idRes)[1])[0];
  const [insp, ir] = await t(() => call(c, "inspect", { filePath: f, target: id }).then(must));
  const [inspJson] = await t(() => call(c, "inspect", { filePath: f, target: id, format: "json" }).then(must));
  rows.push({ file: k, sizeMB: (fs.statSync(SOURCES[k]).size / 1e6).toFixed(1), open: ms(open), read: ms(med(reads)), write: ms(med(writes)), save: ms(save), overviewCold: ms(ovCold), overviewCached: ms(ovWarm), overviewKB: (text(ov).length / 1024).toFixed(1), inspect: ms(insp), inspectLines: text(ir).split("\n").length, inspectJson: ms(inspJson) });
  console.error("done", k);
}
console.log("## Single agent (headless)");
console.table(rows);
console.log(text(await call(c, "list_sessions", {})).split("\n").filter((l) => /median|p90|timing|ms/i.test(l)).join("\n"));
await c.close();

// 2. Four agents in parallel, each on its own file (separate server processes, shared home = shared machine limits).
const agents = await Promise.all(Object.keys(files).map(() => connect({ home, cwd: root })));
const [par, perAgent] = await t(() => Promise.all(Object.entries(files).map(async ([k, f], i) => {
  const a = agents[i]; const lat = [];
  for (let j = 0; j < 10; j++) lat.push((await t(() => call(a, j % 2 ? "execute" : "execute", { filePath: f, input: j % 2 ? `Print(Get((n,c)=>{c.skipChildren();return 1}).length)` : `Insert(document,{type:"rectangle",name:"p${j}",x:-9500,y:${j * 50},width:40,height:40})` }).then(must)))[0]);
  return { file: k, first: ms(lat[0]), medianRest: ms(med(lat.slice(1))), max: ms(Math.max(...lat)) };
})));
console.log(`\n## 4 agents × 4 files in parallel, 10 calls each (5 write + 5 read): wall ${ms(par)}`);
console.table(perAgent);

// 3. Two agents on the same file: the second must fail fast with a clear owner message.
const [conflict, cr] = await t(() => call(agents[1], "execute", { filePath: Object.values(files)[0], input: `Print(1)` }));
console.log(`\n## Same-file conflict: ${ms(conflict)}, isError=${!!cr.isError}\n${text(cr).split("\n")[0].slice(0, 200)}`);
await Promise.all(agents.map((a) => a.close()));

// 4. Integrity: saved files still load and contain the benchmark nodes.
const v = await connect({ home, cwd: root, env });
for (const [k, f] of Object.entries(files)) {
  const r = text(must(await call(v, "execute", { filePath: f, input: `Print("B", Get((n,c)=>{c.skipChildren();return /^(bench|p)\\d$/.test(n.name)?1:undefined}).length)` })));
  console.log(`integrity ${k}: ${/B (\d+)/.exec(r)?.[1]} bench nodes on disk (expect 10)`);
}
await v.close();

// 5. First call on a file this server pre-warmed (a project directory holding just that file).
const [firstKey, firstSrc] = Object.entries(SOURCES)[0];
const pdir = path.join(root, "project");
fs.mkdirSync(pdir);
fs.copyFileSync(firstSrc, path.join(pdir, "app.pen"));
const w = await connect({ home, cwd: pdir, env: { PEN_MULTI_PREWARM_DELAY_MS: "0" } });
const deadline = Date.now() + 60_000;
while (!JSON.parse(text(await call(w, "list_sessions", {}))).sessions.some((s) => s.state === "warm")) {
  if (Date.now() > deadline) throw new Error("pre-warm did not start");
  await new Promise((r) => setTimeout(r, 100));
}
const [warmFirst] = await t(() => call(w, "execute", { filePath: "app.pen", input: `Print(1)` }).then(must));
console.log(`\n## First call on a pre-warmed file (${firstKey}): ${ms(warmFirst)} (cold open above: ${rows[0].open})`);
await w.close();
fs.rmSync(root, { recursive: true, force: true });
