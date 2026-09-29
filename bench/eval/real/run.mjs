// Mutation eval on a real app: from frames that match on the app's committed state, make a
// known change, give an agent the task, and judge with verify plus which side it edited.
// Usage: npm run eval:real -- --app trading-agent [--kinds design-to-code,code-to-design,both]
//        [--n 3] [--servers a/src/index.js,b/src/index.js] [--run]
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { call, connect, text } from "../../../test/helpers.js";
import { readEvents } from "../../../src/events.js";
import { summarize } from "../../../src/report.js";
import { parseStream, score } from "../behavior.mjs";
import { baseline } from "./baseline.mjs";
import { mutate, reader, rng } from "./mutate.mjs";
import { loadApp, makeWorkspace, removeWorkspace, startApp } from "./workspace.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const here = new URL("../../../src/index.js", import.meta.url).pathname;
const app = loadApp(opt("app", "trading-agent"));
const kinds = opt("kinds", "design-to-code,code-to-design,both").split(",");
const n = Number(opt("n", 3));
const servers = opt("servers", here).split(",");
const runs = kinds.length * n * servers.length;
console.log(`${runs} agent runs on ${app.name} (${kinds.join(", ")} × n=${n} × ${servers.length} server(s)); estimate ~${((runs * 300_000) / 1e6).toFixed(1)}M tokens.`);
if (!argv.includes("--run")) {
  console.log("Dry run. Pass --run to spend them.");
  process.exit(0);
}

const sha = (f) => createHash("sha1").update(fs.readFileSync(f)).digest("hex");
const codeDiff = (ws) => execFileSync("git", ["-C", ws.dir, "diff", "HEAD", "--", path.relative(ws.dir, ws.source)], { encoding: "utf8", maxBuffer: 64 << 20 });

/** A text literal of the frame that appears exactly once in the source, replaced in the code. */
function codeMutation(ws, texts, r) {
  const files = execFileSync("git", ["-C", ws.dir, "ls-files", path.relative(ws.dir, ws.source)], { encoding: "utf8" }).split("\n").filter((f) => /\.(tsx?|jsx?)$/.test(f));
  const shuffled = [...texts].sort(() => r() - 0.5);
  for (const t of shuffled) {
    if (t.length < 4) continue;
    const hits = files.filter((f) => fs.readFileSync(path.join(ws.dir, f), "utf8").split(t).length === 2);
    const total = files.reduce((s, f) => s + (fs.readFileSync(path.join(ws.dir, f), "utf8").split(t).length - 1), 0);
    if (hits.length === 1 && total === 1) {
      const file = path.join(ws.dir, hits[0]);
      const to = `${t} (code)`;
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(t, to));
      return { file: hits[0], from: t, to };
    }
  }
  return null;
}

const PROMPTS = {
  "design-to-code": (ws, f) => `The designer updated the frame "${f.name}" (id ${f.id}) in ${ws.pen}; the changes are intentional. The design is the source of truth: update the app's code in ${ws.source} so that pen-multi verify of that frame against the running app reports MATCH. The app runs at ${ws.baseUrl} with hot reload; its routes are in .pen-multi.json. Do not edit the design.`,
  "code-to-design": (ws, f) => `The frame "${f.name}" (id ${f.id}) in ${ws.pen} no longer matches the running app (${ws.baseUrl}, routes in .pen-multi.json). The code is the source of truth: update the design with the pen-multi tools until verify reports MATCH. Do not edit the code.`,
  both: (ws, f) => `The frame "${f.name}" (id ${f.id}) in ${ws.pen} and the running app (${ws.baseUrl}, routes in .pen-multi.json) matched at the last commit. Since then both the design and the code (${ws.source}) were edited by different people. Bring them back in sync with the pen-multi tools.`,
};

const base = await (async () => {
  const ws = await makeWorkspace(app);
  const stop = await startApp(ws);
  try {
    return await baseline(ws, { server: here, log: (m) => console.log(`baseline: ${m}`) });
  } finally {
    stop();
    removeWorkspace(ws);
  }
})();
if (!base.frames.length) throw new Error(`no frame of ${app.name} matches on its committed state`);
console.log(`baseline: ${base.frames.length} frames match at ${base.commit}`);

const results = [];
for (const server of servers) {
  for (const kind of kinds) {
    for (let i = 0; i < n; i++) {
      const seed = [...`${kind}:${i}`].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
      const r = rng(seed);
      let frame = base.frames[Math.floor(r() * base.frames.length)];
      const ws = await makeWorkspace(app);
      const stop = await startApp(ws);
      const row = { server, kind, i, seed, frame: frame.name };
      try {
        // Setup, with this checkout's server (the recorder), before the agent starts.
        const c = await connect({ home: path.join(ws.dir, ".home-setup"), cwd: ws.dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" }, server: here });
        try {
          // The frame must match in this workspace before anything changes; else take another.
          for (let tries = 0; ; tries++) {
            const v = text(await call(c, "verify", { filePath: ws.pen, target: frame.id, source: { kind: "web" }, crops: 0 }));
            if (/Verdict: MATCH/.test(v)) break;
            if (tries >= 3) throw new Error(`setup: no matching frame (last: ${frame.name})`);
            frame = base.frames[Math.floor(r() * base.frames.length)];
            row.frame = frame.name;
          }
          if (kind === "both") {
            // Record the match and commit it, as the prompt says.
            const v = text(await call(c, "verify", { filePath: ws.pen, target: frame.id, source: { kind: "web" }, crops: 0 }));
            if (!/Verdict: MATCH/.test(v)) throw new Error(`setup: ${frame.name} did not match`);
            await call(c, "save", { filePath: ws.pen });
            execFileSync("git", ["-C", ws.dir, "add", "-A"]);
            execFileSync("git", ["-C", ws.dir, "commit", "-q", "-m", "matched", "--allow-empty"]);
          }
          row.mutations = await mutate(c, ws.pen, frame.id, { seed, count: kind === "design-to-code" ? 1 + Math.floor(r() * 3) : 1 });
          if (kind === "both") {
            const texts = JSON.parse(/T (.*)/.exec(text(await call(c, "execute", { filePath: ws.pen, input: `Print("T", JSON.stringify(Get(${JSON.stringify(frame.id)}, (n) => n.type === "text" && n.enabled !== false ? n.content : undefined).filter(Boolean)))` })))[1]);
            row.code = codeMutation(ws, texts.filter((t) => !row.mutations.some((m) => m.what.includes(t))), r);
            if (!row.code) throw new Error("setup: no unique text literal to change in the code");
          }
          await call(c, "save", { filePath: ws.pen });
        } finally {
          await c.close();
        }
        const before = { pen: sha(ws.pen), code: codeDiff(ws) };
        const mcpFile = path.join(ws.dir, ".mcp-eval.json");
        fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "pen-multi": { command: process.execPath, args: [server], env: { PEN_MULTI_APP: "0", PEN_MULTI_HOME: path.join(ws.dir, ".home-agent") } } } }));
        const out = spawnSync("claude", ["-p", PROMPTS[kind](ws, frame), "--mcp-config", mcpFile, "--strict-mcp-config", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"], { cwd: ws.dir, encoding: "utf8", timeout: 25 * 60_000, maxBuffer: 256 << 20 });
        const stream = parseStream(out.stdout);
        const after = { pen: sha(ws.pen), code: codeDiff(ws) };
        // Judge: verify with this checkout's server, and which side moved.
        const j = await connect({ home: path.join(ws.dir, ".home-judge"), cwd: ws.dir, env: { PEN_MULTI_PREWARM: "0", PEN_MULTI_EVENTS: "0" }, server: here });
        let verdict = text(await call(j, "verify", { filePath: ws.pen, target: frame.id, source: { kind: "web" }, crops: 0 }));
        if (!/Verdict: MATCH/.test(verdict)) {
          row.judgeFirst = /Verdict: .*/.exec(verdict)?.[0];
          verdict = text(await call(j, "verify", { filePath: ws.pen, target: frame.id, source: { kind: "web" }, crops: 0 })); // once more: a flake is not a failure
        }
        row.findings = verdict.split("\n").filter((l) => /^\d+\. \[(high|medium)\]/.test(l)).slice(0, 8).map((l) => l.slice(0, 200));
        await j.close();
        const match = /Verdict: MATCH/.test(verdict);
        const penChanged = before.pen !== after.pen, codeChanged = before.code !== after.code;
        const kept = kind !== "both" || (row.code && fs.readFileSync(path.join(ws.dir, row.code.file), "utf8").includes(row.code.to));
        row.pass = match && (kind === "design-to-code" ? !penChanged && codeChanged : kind === "code-to-design" ? penChanged && !codeChanged : penChanged && kept);
        Object.assign(row, { match, penChanged, codeChanged, verdict: /Verdict: .*/.exec(verdict)?.[0], turns: stream.result?.num_turns, tokens: (stream.result?.usage?.input_tokens ?? 0) + (stream.result?.usage?.output_tokens ?? 0) + (stream.result?.usage?.cache_read_input_tokens ?? 0), costUsd: stream.result?.total_cost_usd, tools: stream.calls.filter((x) => !/^(Read|Edit|Write|Bash|Grep|Glob|TodoWrite)$/.test(x.name)).map((x) => x.name) });
        const ev = readEvents(path.join(ws.dir, ".home-agent"), { days: 1 }).events;
        const s = summarize(ev);
        row.mcp = ev.length ? { calls: ev.length, ms: ev.reduce((a, e) => a + e.ms, 0), verifyRuns: s.tools.find((t) => t.tool === "verify")?.calls ?? 0, nextFollowed: s.next.judged ? `${s.next.followed}/${s.next.judged}` : null } : null;
        row.behavior = score({ direction: kind === "both" ? "both" : kind }, stream, { before: { page: "", pen: before.pen }, after: { page: "", pen: after.pen }, page: "-" });
      } catch (err) {
        row.error = String(err.message).slice(0, 300);
      } finally {
        stop();
        removeWorkspace(ws);
      }
      results.push(row);
      console.log(JSON.stringify({ server: path.basename(path.dirname(path.dirname(row.server))), kind, i, frame: row.frame, pass: row.pass, tokens: row.tokens, turns: row.turns, error: row.error }));
    }
  }
}

const outFile = new URL(`../../results/real-${app.name}-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url).pathname;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify({ app: app.name, commit: base.commit, n, kinds, servers, git: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(), results }, null, 1)}\n`);
for (const server of servers) {
  for (const kind of kinds) {
    const rows = results.filter((x) => x.server === server && x.kind === kind);
    const passed = rows.filter((x) => x.pass).length;
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(`${server} · ${kind}: ${passed}/${rows.length} passed; median ${med(rows.map((x) => x.tokens ?? 0))} tokens, ${med(rows.map((x) => x.turns ?? 0))} turns`);
  }
}
console.log(`written ${outFile}`);
