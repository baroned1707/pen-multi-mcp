// Measures the context agents get from overview and inspect on copies of real .pen files:
// tokens per screen, repeated facts, lines. Works against any pen-multi checkout, so a release
// can be measured as a baseline: PEN_MULTI_SERVER=/path/to/checkout/src/index.js.
// Usage: npm run bench:context -- [--screens N] [--out file.json] a.pen [b.pen ...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { call, connect, text } from "../test/helpers.js";
import { approxTokens, redundancy } from "../src/metrics/context.js";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const perFile = Number(opt("screens", 8));
const outFile = opt("out", null);
if (!argv.length) {
  console.error("Usage: npm run bench:context -- [--screens N] [--out file.json] <file.pen> [more.pen ...]");
  process.exit(2);
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-context-")));
const c = await connect({ home: path.join(root, "home"), cwd: root, env: { PEN_MULTI_PREWARM: "0" } });
const server = process.env.PEN_MULTI_SERVER ?? "working tree";
const result = { server, measuredAt: new Date().toISOString(), proxy: "tokens = UTF-8 bytes / 4", files: [] };
try {
  for (const src of argv) {
    const file = path.join(root, path.basename(src));
    fs.copyFileSync(path.resolve(src), file); // the original is never opened
    const ov = text(await call(c, "overview", { filePath: file }));
    // Screens: top-level frames that are not components, sampled evenly across the file.
    const listed = text(await call(c, "execute", { filePath: file, input: 'Print("F", JSON.stringify(Get((n, c) => { c.skipChildren(); return n.type === "frame" && !n.reusable && n.width >= 300 ? n.id : undefined; })))' }));
    const all = JSON.parse(/F (.*)/.exec(listed)?.[1] ?? "[]").filter(Boolean);
    const step = Math.max(1, Math.floor(all.length / perFile));
    const ids = all.filter((_, i) => i % step === 0);
    const screens = [];
    for (const id of ids) {
      if (screens.length >= perFile) break;
      const res = await call(c, "inspect", { filePath: file, target: id });
      if (res.isError) continue;
      const t = text(res);
      const outline = t.split("\n## Outline\n")[1]?.split("\n") ?? [];
      screens.push({ id, tokens: approxTokens(t), lines: outline.length, redundancy: +redundancy(outline).toFixed(3) });
    }
    const avg = (k) => (screens.length ? +(screens.reduce((s, x) => s + x[k], 0) / screens.length).toFixed(3) : null);
    result.files.push({ file: path.basename(src), overviewTokens: approxTokens(ov), screens, avg: { tokens: avg("tokens"), lines: avg("lines"), redundancy: avg("redundancy") } });
    console.log(`${path.basename(src)}: overview ${approxTokens(ov)} tok; inspect avg ${avg("tokens")} tok, ${avg("lines")} lines, redundancy ${avg("redundancy")} over ${screens.length} screens`);
  }
} finally {
  await c.close();
  fs.rmSync(root, { recursive: true, force: true });
}
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(result, null, 1)}\n`);
  console.log(`written ${outFile}`);
}
