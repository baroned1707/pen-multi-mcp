// project_context: the product intent (the brief an agent wrote and the user approved), the parts
// that are always current (tokens, components, scales, canvas notes, code mapping), and what changed
// since the brief was stamped. Also attached once per file to the first design-tool result.
import fs from "node:fs";
import path from "node:path";
import { renderOverview } from "../design/overview.js";
import { projectMapping } from "../mapping/index.js";
import { SYNC_DIR } from "../sync/index.js";
import { STAMP_FILE, briefConfig, digestOf, sinceLines, sinceStamp, snapshotNow } from "./brief.js";
import { parseRules, rulesLine } from "./rules.js";

export function registerContextTools({ tool, z, route, design, conventions, optionalFilePath, executeSnippet, withMachineLock }) {
  const stampPath = (file) => path.join(path.dirname(file), SYNC_DIR, STAMP_FILE);

  async function gather(target) {
    const conv = conventions(target.file);
    const brief = briefConfig(target.file, conv);
    const briefText = fs.existsSync(brief.file) ? fs.readFileSync(brief.file, "utf8") : null;
    const { analysis } = await design.analysisOf(target);
    const v = await design.reader(target)(`const v = GetVariables(); Print("V", JSON.stringify({ variables: v.variables || {}, themes: v.themes || {} }))`);
    const { variables = {} } = JSON.parse(/V (.*)/.exec(v.text ?? "")?.[1] ?? "{}");
    const mapping = projectMapping({ penFile: target.file, conv, variables, components: analysis.components.filter((c) => c.instances > 0) });
    const codeComponents = [...mapping.components.values()].filter((c) => !c.problem).map((c) => c.code);
    const now = snapshotNow({ root: process.cwd(), brief, routes: Object.keys(conv.routes ?? {}), components: codeComponents, tokens: [...Object.keys(variables).map((k) => `$${k}`), ...mapping.tokens.values()] });
    let stamp = null;
    try {
      stamp = JSON.parse(fs.readFileSync(stampPath(target.file), "utf8"));
    } catch {}
    return { conv, brief, briefText, analysis, variables, mapping, now, stamp, since: stamp ? sinceStamp(stamp, now, process.cwd()) : null };
  }

  const valueOf = (v) => (Array.isArray(v.value) ? v.value.map((e) => `${e.value}${e.theme ? ` ${Object.values(e.theme)[0]}` : ""}`).join(" / ") : String(v.value));

  /** The brief part: status, digest or full text, and what changed since it was stamped. */
  function briefLines(g, detail) {
    const L = [];
    if (!g.briefText) {
      L.push(`No brief at ${g.brief.rel}: agents design without the product's intent (who it is for, voice, visual direction, rules).`, 'Next: the write-brief prompt — read the project\'s own documents, draft the brief, ask the user to approve it, then project_context({ action: "stamp" }).');
      return L;
    }
    L.push(`Brief: ${g.brief.rel}${g.stamp ? "" : " (never stamped: what changes it depends on is unknown)"}`);
    const text = detail === "full" ? g.briefText.split("\n").slice(0, 400) : digestOf(g.briefText);
    L.push(...text);
    const { rules, errors, blocks } = parseRules(g.briefText);
    if (blocks) L.push("", `Rules checked by lint (design) and verify (code): ${rulesLine(rules) || "none"}`);
    for (const e of errors) L.push(`WARNING: ${e}`);
    if (g.brief.references?.length) L.push(`References (read them with the brief): ${g.brief.references.join(", ")}`);
    if (g.since) {
      L.push("", ...sinceLines(g.stamp, g.since));
      if (g.since.stale) L.push("Next: the refresh-brief prompt — update the sections these changes touch, ask the user, then stamp again.");
    } else L.push("", 'Next: after the user approves the brief, project_context({ action: "stamp" }) so its sources and the project it describes are recorded.');
    return L;
  }

  function render(g, detail) {
    const L = ["# Project context", "", "## Brief", ...briefLines(g, detail), "", "## Design system (from the .pen, always current)"];
    const tokens = Object.entries(g.variables);
    if (tokens.length) L.push(`Tokens (${tokens.length}): ${tokens.slice(0, detail === "full" ? 200 : 30).map(([k, v]) => `$${k} ${valueOf(v)}${g.mapping.tokens.get(`$${k}`) ? ` (code ${g.mapping.tokens.get(`$${k}`)})` : ""}`).join(" · ")}${tokens.length > (detail === "full" ? 200 : 30) ? " · …" : ""}`);
    const ov = renderOverview(g.analysis, { file: "" });
    L.push(...ov.filter((l) => /^## (Type scale|Spacing|Fills)|^\d+ root nodes/.test(l)));
    const comps = g.analysis.components.filter((c) => c.instances > 0).slice(0, 10);
    if (comps.length) L.push(`Most used components: ${comps.map((c) => `${c.name} ×${c.instances}${g.mapping.components.get(c.id)?.code ? ` (code ${g.mapping.components.get(c.id).code})` : ""}`).join(", ")}`);
    const notes = g.analysis.notes ?? [];
    if (notes.length) L.push("", "## Notes on the canvas", ...notes.slice(0, detail === "full" ? 40 : 8).map((n) => `- ${String(n).replace(/\s+/g, " ").slice(0, 200)}`));
    return L;
  }

  tool(
    "project_context",
    'Use before designing a new screen or changing the design, and when a result says the brief is missing or out of date: the product\'s intent (the brief), the design system as it is now, canvas notes, and what changed in the project since the brief was written. action "stamp" records what the approved brief was written against (sources, commit, routes, code components, tokens) and puts its outline on the canvas as a note.',
    {
      filePath: optionalFilePath,
      detail: z.enum(["digest", "full"]).optional().describe('"digest" (default): the brief\'s outline; "full": all of it.'),
      action: z.enum(["read", "stamp"]).optional().describe('"read" (default), or "stamp" after the user approved the brief.'),
      note: z.boolean().optional().describe("stamp: also write the brief's outline as a note on the canvas (default true)."),
    },
    async ({ filePath: f, detail = "digest", action = "read", note = true }) => {
      const target = await route(f);
      const g = await gather(target);
      if (action === "stamp") {
        if (!g.briefText) return design.wrap(target, [`Nothing to stamp: no brief at ${g.brief.rel}. Write it first (the write-brief prompt).`]);
        const file = stampPath(target.file);
        await withMachineLock(`brief:${target.file}`, async () => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(g.now, null, 1)}\n`);
          fs.renameSync(`${file}.tmp`, file);
        });
        const lines = [`Stamped ${g.brief.rel} against ${g.now.commit ? g.now.commit.slice(0, 7) : "the current files"}: ${Object.keys(g.now.sources).length} source(s), ${g.now.routes.length} routes, ${g.now.components.length} code components, ${g.now.tokens.length} tokens — in ${path.relative(process.cwd(), file)} (commit it).`];
        if (note) {
          const content = [`Project brief — ${g.brief.rel} (stamped ${g.now.at.slice(0, 10)})`, "", ...digestOf(g.briefText, 30)].join("\n");
          const q = JSON.stringify;
          const out = await executeSnippet({
            filePath: target.file,
            input: `const ex = Get((n, c) => { c.skipChildren(); return n.type === "text" && n.name === "Project brief" ? n.id : undefined; }).filter(Boolean)[0];
if (ex) { Update(ex, { content: ${q(content)} }); Print("NOTE", ex, "updated"); }
else { let minX = 0; Get((n, c) => { c.skipChildren(); minX = Math.min(minX, c.bounds.x || 0); return undefined; }); const id = Insert(document, { type: "text", name: "Project brief", content: ${q(content)}, x: minX - 600, y: 0, width: 520, textGrowth: "fixed-width", fontSize: 14, lineHeight: 1.5, fill: "#111111" }); Print("NOTE", id, "added"); }`,
          });
          const t = out.content.map((c) => c.text ?? "").join("\n");
          const m = /NOTE (\S+) (\w+)/.exec(t);
          lines.push(m ? `Canvas note "Project brief" ${m[2]} (${m[1]}), left of the screens.` : `The canvas note could not be written: ${t.slice(0, 200)}`);
        }
        return design.wrap(target, lines);
      }
      return design.wrap(target, render(g, detail));
    },
  );

  // Attached once per file and process to the first design-tool result.
  const attached = new Set();
  return {
    async attach(file) {
      if (!file || attached.has(file)) return null;
      attached.add(file);
      try {
        const target = await route(file);
        const g = await gather(target);
        return ["", "## Project brief (shown once per file; project_context for all of it)", ...briefLines(g, "digest")].join("\n");
      } catch {
        return null; // context must never break a call
      }
    },
  };
}
