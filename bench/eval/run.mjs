// Tier 2: runs headless Claude Code agents on the eval tasks against one or two pen-multi
// checkouts and records MATCH, verify runs and tokens. Costs real tokens: a dry run (plan and
// estimate) unless --run is given.
// Usage: npm run eval -- [--run] [--n 3] [--tasks port,fix] [--servers a/src/index.js,b/src/index.js]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseStream, score } from "./behavior.mjs";
import { readEvents } from "../../src/events.js";
import { summarize } from "../../src/report.js";
import { check, workspace } from "./lib.mjs";
import { TASKS } from "./tasks.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const n = Number(opt("n", 3));
const tasks = opt("tasks", Object.keys(TASKS).join(",")).split(",");
const here = new URL("../../src/index.js", import.meta.url).pathname;
const servers = opt("servers", here).split(",");
const EST_TOKENS_PER_RUN = 150_000; // rough: ~20 turns with inspect/verify outputs

const runs = tasks.length * servers.length * n;
console.log(`${runs} agent runs (${tasks.join(", ")} × ${servers.length} server(s) × n=${n}); estimate ~${((runs * EST_TOKENS_PER_RUN) / 1e6).toFixed(1)}M tokens.`);
if (!flag("run")) {
  console.log("Dry run. Pass --run to spend them.");
  process.exit(0);
}

const results = [];
for (const server of servers) {
  for (const task of tasks) {
    for (let i = 0; i < n; i++) {
      // Every side gets the same design: built by the first server, so only the context differs.
      const w = await workspace(task, servers[0]);
      const mcp = path.join(w.dir, "mcp.json");
      fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { "pen-multi": { command: process.execPath, args: [server], env: { PEN_MULTI_APP: "0", PEN_MULTI_HOME: path.join(w.dir, "home-agent") } } } }));
      const snap = () => ({ page: fs.readFileSync(w.page, "utf8"), pen: createHash("sha1").update(fs.readFileSync(w.pen)).digest("hex") });
      const before = snap();
      const r = spawnSync("claude", ["-p", TASKS[task].prompt(w), "--mcp-config", mcp, "--strict-mcp-config", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"], { cwd: w.dir, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 256 << 20 });
      const stream = parseStream(r.stdout);
      const out = stream.result ?? {};
      const behavior = score(TASKS[task], stream, { before, after: snap(), page: path.basename(w.page) });
      const verdict = await check(w, servers[0]); // one judge for every side
      // What the MCP itself did in this run, from its events (servers that write them).
      const events = readEvents(path.join(w.dir, "home-agent"), { days: 1 }).events;
      const ev = summarize(events);
      const mcpStats = ev.calls ? { calls: Object.fromEntries(ev.tools.map((t) => [t.tool, t.calls])), ms: events.reduce((sum, e) => sum + e.ms, 0), tokens: events.reduce((sum, e) => sum + (e.tokens?.text ?? 0) + (e.tokens?.image ?? 0), 0), errors: ev.tools.reduce((sum, t) => sum + t.errors, 0), nextFollowed: ev.next.judged ? `${ev.next.followed}/${ev.next.judged}` : null } : null;
      const row = { server, task, i, match: verdict.match, verdict: verdict.summary, turns: out.num_turns, tokens: (out.usage?.input_tokens ?? 0) + (out.usage?.output_tokens ?? 0) + (out.usage?.cache_read_input_tokens ?? 0), costUsd: out.total_cost_usd, behavior, mcp: mcpStats, error: r.status ? (r.stderr || "").slice(0, 300) : undefined };
      results.push(row);
      console.log(JSON.stringify(row));
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  }
}
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "results", `eval-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ n, tasks, servers, git: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(), results }, null, 1)}\n`);
console.log(`written ${out}`);
