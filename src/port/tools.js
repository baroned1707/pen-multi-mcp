// port: a durable queue for porting a design screen by screen until verify says MATCH.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ReadError } from "../design/read.js";
import { slug } from "../verify/tools.js";
import { counts, nextItem, planQueue, recordVerify, settle } from "./queue.js";

const OUT_DIR = "design-verify";
const sha1 = (file) => (fs.existsSync(file) ? createHash("sha1").update(fs.readFileSync(file)).digest("hex") : null);

export function registerPortTools({ tool, z, route, design, optionalFilePath, conventions, withMachineLock, saver, stateFor }) {
  const queuePath = (file) => path.join(process.cwd(), OUT_DIR, `port-${slug(path.basename(file, ".pen"))}-${createHash("sha1").update(file).digest("hex").slice(0, 6)}.json`);
  const load = (file) => {
    const p = queuePath(file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  };
  const store = (file, q) => {
    const p = queuePath(file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(q, null, 1));
    fs.renameSync(`${p}.tmp`, p);
  };
  // Read-modify-write under a machine-wide lock: parallel subagents and other sessions share it.
  const update = (file, fn) => withMachineLock(`port:${file}`, async () => {
    const out = await fn(load(file));
    if (out?.queue) store(file, out.queue);
    return out;
  });

  /** The newest verify report of a frame for this .pen. */
  const latestReport = (file, id) => {
    const dir = path.join(process.cwd(), OUT_DIR);
    let best = null;
    for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!n.endsWith(".json") || n.startsWith("port-")) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
        if (r?.target?.id === id && r.pen?.path === file && (!best || r.generatedAt > best.report.generatedAt)) best = { report: r, path: path.join(dir, n) };
      } catch {}
    }
    return best;
  };

  const LOOP = "Loop: inspect the frame (savePath below) → implement it, marking elements with data-pen / testID=\"pen:…\" → verify (target = this id) → fix and verify again until MATCH → port done → port next. After the item's attempts run out it is blocked: say why with port block and move on.";

  function describeNext(item, file) {
    const conv = conventions(file);
    const lines = [`# Next: ${item.name} (${item.id})${item.width ? ` · ${item.width}` : ""}${item.theme ? ` · ${item.theme}` : ""}`, `Claimed by "${item.claim}" until ${item.leaseUntil}; attempts so far: ${item.attempts ?? 0}.`];
    const st = item.stateConfig;
    if (item.route) lines.push(`Page: ${/^[a-z]+:/i.test(item.route) ? item.route : `${(conv.baseUrl ?? "<baseUrl>").replace(/\/+$/, "")}/${item.route.replace(/^\/+/, "")}`}`);
    else lines.push(`No route for this screen yet: add it to .pen-multi.json { "baseUrl": …, "routes": { "${item.screen}": "/path" } } or pass source.url to verify.`);
    if (st) lines.push(`State "${st.key}" from .pen-multi.json: ${JSON.stringify({ route: st.route, steps: st.steps, mocks: st.mocks?.map((m) => m.url), deepLink: st.deepLink })}`);
    else if (item.state) lines.push(`This is the "${item.state}" state: put the app in it for verify (source.mocks / steps, or a states entry in .pen-multi.json keyed "${item.screen} — ${item.state}").`);
    const last = latestReport(file, item.id);
    if (last) {
      const f = (last.report.findings ?? []).filter((x) => x.severity !== "low").slice(0, 10);
      lines.push("", `Last verify: ${last.report.summary.verdict.toUpperCase()} (${last.report.summary.high} high, ${last.report.summary.medium} medium) — ${last.path}`, ...f.map((x) => `- [${x.severity}] ${x.message}`));
    }
    lines.push("", `Spec: inspect({ target: ${JSON.stringify(item.id)}, savePath: "design-verify/specs/${slug(item.name)}.json" })`, LOOP);
    return lines;
  }

  tool(
    "port",
    `A durable queue for porting a design screen by screen until verify reports MATCH — survives context compaction and is shared by parallel subagents. action "plan" lists every frame (screen × state × width × theme, filterable) with its route/state config; "next" claims the next screen (pass claim: "<your name>" when several agents work in parallel) and returns its id, page, state setup, last findings and the loop; "done" marks it finished only if its latest verify is MATCH for the current design; "skip"/"block" with a reason; "status" shows progress. verify records every run on the queue.`,
    {
      filePath: optionalFilePath,
      action: z.enum(["plan", "next", "done", "skip", "block", "status"]),
      id: z.string().optional().describe("done/skip/block: the frame id."),
      reason: z.string().optional().describe("skip/block: why."),
      claim: z.string().optional().describe('next: who takes the item (default "main"); parallel subagents use distinct names.'),
      filter: z.string().optional().describe("plan: only screens whose name, state or code contains this."),
      widths: z.array(z.number()).optional().describe("plan: only these widths."),
      themes: z.array(z.string()).optional().describe("plan: only these themes."),
      maxAttempts: z.number().int().min(1).max(50).optional().describe("plan: verify runs per screen before it is blocked (default 5)."),
    },
    async ({ filePath: f, action, id, reason, claim = "main", filter, widths, themes, maxAttempts }) => {
      const target = await route(f);
      const file = target.file;
      if (action === "plan") {
        const { analysis } = await design.analysisOf(target, { refresh: true });
        const conv = conventions(file);
        const low = filter?.toLowerCase();
        const cells = analysis.matrix.rows.flatMap((r) =>
          Object.entries(r.cells).flatMap(([w, cs]) =>
            cs.map((c) => ({ id: c.id, name: c.name, screen: r.screen, state: r.state, code: r.code, width: Number(w) || w, theme: c.theme ?? null, row: r })),
          ),
        ).filter((c) => (!low || [c.name, c.screen, c.state, c.code].some((v) => v && String(v).toLowerCase().includes(low))) && (!widths || widths.map(String).includes(String(c.width))) && (!themes || themes.includes(c.theme)));
        if (!cells.length) throw new ReadError("No frames match the filter.");
        for (const c of cells) {
          // The same lookup verify uses (frame name, then "Screen — state", then screen / code).
          c.route = [c.name, c.row.state ? `${c.screen} — ${c.row.state}` : null, c.screen, c.code].map((k) => k && conv.routes?.[k]).find(Boolean) ?? null;
          c.stateConfig = stateFor(target, c.name, { name: c.name, row: c.row }) ?? null;
          if (!c.route && c.stateConfig?.route) c.route = c.stateConfig.route;
          delete c.row;
        }
        const frameIds = new Set(analysis.matrix.rows.flatMap((r) => Object.values(r.cells).flat().map((c) => c.id)));
        const out = await update(file, (q) => ({ queue: planQueue(q, cells, { maxAttempts, frameIds }) }));
        const n = counts(out.queue);
        return design.wrap(target, [
          `Port queue: ${out.queue.items.length} frames (${n.todo} todo, ${n["in-progress"]} in progress, ${n.match} match, ${n.blocked} blocked, ${n.skipped} skipped) — ${queuePath(file)}`,
          `${cells.filter((c) => !c.route).length} without a route, ${cells.filter((c) => c.state && !c.stateConfig).length} states without a states entry in .pen-multi.json.`,
          "Next: port({ action: \"next\" }) — or, with several agents, one claim name each.",
        ]);
      }
      if (action === "next") {
        const out = await update(file, (q) => {
          if (!q) throw new ReadError("No port queue for this file yet: port({ action: \"plan\" }) first.");
          return nextItem(q, claim);
        });
        if (!out.item) {
          const n = counts(out.queue);
          const held = out.queue.items.filter((i) => i.status === "in-progress").map((i) => i.leaseUntil).sort()[0];
          return design.wrap(target, [
            `Nothing left for "${claim}": ${n.match} match, ${n.blocked} blocked, ${n.skipped} skipped, ${n["in-progress"]} in progress by others.`,
            n["in-progress"]
              ? `Other agents hold ${n["in-progress"]} item(s); a lease expires at ${held} — if an agent stopped, call port next again after that to take its item over.`
              : n.blocked
                ? "Blocked items need the user: port({ action: \"status\" }) lists why."
                : "The port is complete.",
          ]);
        }
        return design.wrap(target, describeNext(out.item, file));
      }
      let freshness = "";
      if (action === "done") {
        if (!id) throw new ReadError("done needs the frame id.");
        await saver?.flush(file).catch(() => {});
        // The run the queue recorded last for this frame (verify writes it), else the newest report.
        const recorded = load(file)?.items.find((i) => i.id === id)?.lastReport;
        const last = recorded && fs.existsSync(recorded) ? { report: JSON.parse(fs.readFileSync(recorded, "utf8")), path: recorded } : latestReport(file, id);
        if (!last) throw new ReadError(`${id} has not been verified yet: run verify({ target: ${JSON.stringify(id)}, source }) until it reports MATCH.`);
        const s = last.report.summary;
        if (s.verdict !== "match") throw new ReadError(`${id} is not done: its latest verify DIFFERS (${s.high} high, ${s.medium} medium) — ${last.path}. Fix and verify again.`);
        const now = target.mode === "app" ? null : sha1(file);
        if (now && last.report.pen?.sha1 && last.report.pen.sha1 !== now) throw new ReadError(`${id} was verified against an older version of the design; verify again before done.`);
        if (!now || !last.report.pen?.sha1) freshness = " (the design is open in the pen.dev app, so whether it changed since the verify was not checked)";
        const out = await update(file, (q) => {
          if (!q) throw new ReadError("No port queue for this file: port({ action: \"plan\" }) first.");
          return settle(q, id, "match");
        });
        const n = counts(out.queue);
        return design.wrap(target, [`${out.item.name} (${id}) is done: MATCH${freshness}.`, `${n.match}/${out.queue.items.length} done, ${n.todo + n["in-progress"]} left, ${n.blocked} blocked.`, n.todo + n["in-progress"] ? "Next: port({ action: \"next\" })." : "Nothing left to take."]);
      }
      if (action === "skip" || action === "block") {
        if (!id || !reason) throw new ReadError(`${action} needs id and reason.`);
        const out = await update(file, (q) => {
          if (!q) throw new ReadError("No port queue for this file: port({ action: \"plan\" }) first.");
          return settle(q, id, action === "skip" ? "skipped" : "blocked", reason);
        });
        return design.wrap(target, [`${out.item.name} (${id}) ${action === "skip" ? "skipped" : "blocked"}: ${reason}.`, "Next: port({ action: \"next\" })."]);
      }
      // status
      const q = load(file);
      if (!q) return design.wrap(target, ["No port queue for this file yet: port({ action: \"plan\" })."]);
      const n = counts(q);
      const lines = [`# Port: ${q.items.length} frames — ${n.match} match, ${n["in-progress"]} in progress, ${n.todo} todo, ${n.blocked} blocked, ${n.skipped} skipped`, "", "frame | status | attempts | last verify | who / why"];
      for (const i of q.items) {
        lines.push(`${i.name} (${i.id}) | ${i.status} | ${i.attempts ?? 0} | ${i.lastVerdict ? `${i.lastVerdict}${i.lastCounts ? ` ${i.lastCounts.high}h/${i.lastCounts.medium}m` : ""}` : "–"} | ${i.status === "in-progress" ? i.claim : i.reason ?? ""}`);
      }
      return design.wrap(target, lines);
    },
  );

  /** Called by verify after each report: records the run on the frame's queue item. */
  return {
    async onVerify(file, id, report, reportPath) {
      if (!fs.existsSync(queuePath(file))) return;
      await update(file, (q) => (q ? recordVerify(q, id, { verdict: report.summary.verdict, report: reportPath, high: report.summary.high, medium: report.summary.medium }) : null)).catch((err) =>
        process.stderr.write(`pen-multi: could not record the verify of ${id} on the port queue: ${err.message}\n`),
      );
    },
  };
}
