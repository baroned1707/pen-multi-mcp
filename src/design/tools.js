// The design-context tools: overview (big picture of a document) and inspect (one screen or node
// as data an agent can implement from). Both only read; they never mark a file dirty or save it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildModel } from "./model.js";
import { outline, sections, toJson } from "./inspect.js";
import { analyze, renderOverview } from "./overview.js";
import { ReadError, readOverview, readSubtree } from "./read.js";

const APP_CACHE_MS = 60_000;

/** `.pen-multi.json` next to the .pen: { screenPattern, flows: ["docs/flow.json", ...] }. */
function conventions(file) {
  const p = path.join(path.dirname(file), ".pen-multi.json");
  if (!fs.existsSync(p)) return {};
  const conf = JSON.parse(fs.readFileSync(p, "utf8"));
  const flowEdges = [];
  for (const f of conf.flows ?? []) {
    const doc = JSON.parse(fs.readFileSync(path.resolve(path.dirname(p), f), "utf8"));
    flowEdges.push(...(doc.edges ?? []));
  }
  return { screenPattern: conf.screenPattern, flowEdges };
}

const fileHash = (file) => (fs.existsSync(file) ? createHash("sha1").update(fs.readFileSync(file)).digest("hex") : null);
const mtime = (file) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);

export function registerDesignTools({ tool, z, route, app, pool, saver, timings, ok, fail, fromApp, textOf, optionalFilePath }) {
  const cache = new Map(); // file -> { key, analysis }
  const invalidate = (file) => cache.delete(file);

  /** A `run(input)` for read-only snippets on the routed document. */
  const reader = (target) =>
    target.mode === "app"
      ? async (input) => {
          const res = await timings.time("call", () => app.call("execute", { filePath: target.file, input }));
          return res.isError ? { error: textOf(res) } : { text: textOf(res) };
        }
      : (input) => pool.use(target.file, (session) => timings.time("call", () => session.shell.call("execute", { input })));

  async function analysisOf(target, { refresh = false } = {}) {
    const key = target.mode === "app" ? `app:${Math.floor(Date.now() / APP_CACHE_MS)}` : `disk:${mtime(target.file)}`;
    const hit = cache.get(target.file);
    if (!refresh && hit && hit.key === key) return { ...hit, cached: true };
    const conv = conventions(target.file);
    const { data, stats, unavailable } = await readOverview(reader(target));
    const entry = { key, analysis: analyze(data, stats, conv), unavailable, readAt: new Date().toISOString() };
    cache.set(target.file, entry);
    return { ...entry, cached: false };
  }

  const wrap = (target, lines) =>
    target.mode === "app" ? fromApp({ content: [{ type: "text", text: lines.join("\n") }] }, target) : ok(lines.join("\n"), [], target.file);

  tool(
    "overview",
    `The big picture of a .pen document, before designing or implementing anything: every screen as a matrix (screen + state × width, with the themes each cell is drawn in, empty cells shown), canvas bands in reading order, flows between screens (inferred from arrows, or declared), components with where they are used, the type and spacing scales in use, raw colors, and the intent notes left in the file. Use focus to zoom into one screen or code (e.g. "S3", "Checkout"), which also lists each frame's node id for inspect. A .pen-multi.json next to the file can declare { "screenPattern": "<regex with named groups screen, state, width, theme>", "flows": ["path/to/flow.json"] }.`,
    {
      filePath: optionalFilePath,
      focus: z.string().optional().describe("Screen code, name fragment or node id to narrow the output to."),
      refresh: z.boolean().optional().describe("Re-read instead of using the cached analysis."),
    },
    async ({ filePath: f, focus, refresh }) => {
      const target = await route(f);
      const { analysis, cached, readAt, unavailable } = await analysisOf(target, { refresh });
      const lines = renderOverview(analysis, { file: target.file, focus });
      if (cached) lines.push("", `(cached analysis from ${readAt}; pass refresh: true after changing the document)`);
      if (unavailable.length) lines.push(`(${unavailable.length} root frames were too large to read for statistics)`);
      return wrap(target, lines);
    },
  );

  /**
   * Resolves a target: an exact frame id or name; else any node id that exists; else a unique
   * screen code / partial name. Ambiguous or unknown targets list candidates instead of guessing.
   */
  async function resolveTarget(target, wanted, { refreshed = false } = {}) {
    const { analysis } = await analysisOf(target, { refresh: refreshed });
    const frames = analysis.matrix.rows.flatMap((r) => Object.values(r.cells).flat().map((c) => ({ ...c, row: r })));
    const exact = frames.filter((c) => c.id === wanted || c.name === wanted);
    if (exact.length === 1) return { id: exact[0].id, frame: exact[0], analysis };
    if (!exact.length && /^[\w-]+(\/[\w-]+)*$/.test(wanted)) {
      try {
        const raw = await readSubtree(reader(target), wanted);
        return { id: wanted, frame: null, analysis, raw };
      } catch (err) {
        if (!/can't find node|not found|does not exist/i.test(err.message)) throw err;
      }
    }
    const lower = wanted.toLowerCase();
    // Exact name matches win over partial ones; two frames with the same name are still ambiguous.
    const loose = exact.length ? exact : frames.filter((c) => c.row.code?.toLowerCase() === lower || c.name.toLowerCase().includes(lower));
    if (loose.length === 1) return { id: loose[0].id, frame: loose[0], analysis };
    if (loose.length > 1) {
      throw new ReadError(`"${wanted}" matches ${loose.length} frames; pass one id:\n` + loose.slice(0, 30).map((c) => `- ${c.name} → ${c.id}`).join("\n"));
    }
    if (!refreshed) return resolveTarget(target, wanted, { refreshed: true }); // the document may have changed
    const words = lower.split(/[\s·—-]+/).filter((w) => w.length > 1);
    const close = frames
      .map((c) => ({ c, score: words.filter((w) => c.name.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    throw new ReadError(
      `No screen or node matches "${wanted}".` + (close.length ? ` Closest screens:\n${close.map((x) => `- ${x.c.name} → ${x.c.id}`).join("\n")}` : " Call overview to list screens and their ids."),
    );
  }

  function breadcrumb(analysis, frame, model) {
    const lines = [];
    if (frame) {
      const row = frame.row;
      const variants = Object.entries(row.cells).flatMap(([w, cs]) => cs.map((c) => `${c.name} (${w}${c.theme ? `, ${c.theme}` : ""}) → ${c.id}`));
      lines.push(`Screen: ${row.screen}${row.state ? ` — state ${row.state}` : ""}`);
      const states = analysis.matrix.rows.filter((r) => r.screen === row.screen && r !== row).map((r) => r.state ?? "(default)");
      if (states.length) lines.push(`Other states of this screen: ${states.join(", ")}`);
      lines.push(`Variants: ${variants.join("; ")}`);
      const band = analysis.bands.find((b) => b.screens.some((s) => s.id === frame.id));
      if (band?.label) lines.push(`Band: ${band.label}`);
      const names = new Set(Object.values(row.cells).flat().map((c) => c.name));
      const inbound = analysis.flows.filter((f) => names.has(f.to)).map((f) => `${f.from}${f.label ? ` "${f.label}"` : ""}`);
      const outbound = analysis.flows.filter((f) => names.has(f.from)).map((f) => `${f.to}${f.label ? ` "${f.label}"` : ""}`);
      if (inbound.length) lines.push(`Comes from: ${[...new Set(inbound)].join("; ")}`);
      if (outbound.length) lines.push(`Goes to: ${[...new Set(outbound)].join("; ")}`);
    }
    const used = new Map();
    for (const n of model.nodes.values()) if (n.component && !n.id.includes("/")) used.set(n.component.name, (used.get(n.component.name) ?? 0) + 1);
    if (used.size) lines.push(`Components used: ${[...used].map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    return lines;
  }

  tool(
    "inspect",
    `Read one screen or node of a .pen design as data to implement from, instead of looking at screenshots: where it sits (other widths, states, themes, flows in and out, components used), its sections in order with the app shell (docked header, tab bar) marked, and an outline with one line per node: absolute position and size, sizing (fill/hug/fixed), auto-layout, colors as token name plus the value in every theme, typography with line height in px, components and overrides, clipping. Repeated rows are collapsed. flavor adds code hints per node (tailwind, css or react-native) following pen.dev's layout rules. format "json" returns the full data for scripts; "html-ref" writes Pen's HTML export with its box-sizing bug fixed and layer names as data-pen. savePath writes the JSON (with the .pen's hash) so it can be re-read after context compaction.`,
    {
      filePath: optionalFilePath,
      target: z.string().describe("Node id, or a screen name / code (e.g. \"S3 · Trang tin · sáng\", \"M5\"). Use overview with focus to find ids."),
      depth: z.number().int().min(0).max(40).optional().describe("Outline depth (default 8)."),
      maxLines: z.number().int().min(20).max(3000).optional().describe("Outline line limit (default 400)."),
      flavor: z.enum(["tailwind", "css", "react-native"]).optional().describe("Add per-node code hints in this flavor."),
      format: z.enum(["outline", "json", "html-ref"]).optional().describe("outline (default), json, or html-ref."),
      savePath: z.string().optional().describe("Write the JSON spec here (relative to the agent's working directory), e.g. design-spec/home.json."),
    },
    async ({ filePath: f, target: wanted, depth = 8, maxLines = 400, flavor, format = "outline", savePath }) => {
      const target = await route(f);
      const resolved = await resolveTarget(target, wanted);
      const { id, frame, analysis } = resolved;
      const run = reader(target);
      const raw = resolved.raw ?? (await readSubtree(run, id));
      const model = buildModel(raw);
      const crumb = breadcrumb(analysis, frame, model);
      const sec = sections(model);
      const notes = [];

      if (savePath) {
        const out = path.resolve(process.cwd(), savePath);
        if (!/\.json$/i.test(out)) throw new ReadError(`savePath must end with .json: ${savePath}`);
        let prev = null;
        if (fs.existsSync(out)) {
          try {
            prev = JSON.parse(fs.readFileSync(out, "utf8"));
          } catch {}
          if (!prev?.pen?.sha1) throw new ReadError(`${out} exists and is not an inspect spec; refusing to overwrite it.`);
        }
        // Hash what is on disk after pending saves, so the hash matches the data just read.
        await saver?.flush(target.file).catch(() => {});
        const unsaved = Boolean(pool.sessions.get(target.file)?.dirty);
        const hash = fileHash(target.file);
        if (prev && prev.pen.sha1 !== hash) notes.push(`The previous spec at ${out} was stale: the design changed since ${prev.generatedAt}.`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(
          out,
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              pen: { path: target.file, mtimeMs: mtime(target.file), sha1: hash, live: target.mode === "app", unsavedChangesNotHashed: unsaved || undefined },
              target: { id, name: model.root.name },
              breadcrumb: crumb,
              shell: sec.shell.map((s) => ({ name: s.node.name, where: s.where, items: s.items })),
              sections: sec.sections.map((s) => ({ name: s.node.name, fixed: s.fixed, items: s.items })),
              ...toJson(model),
            },
            null,
            2,
          ),
        );
        notes.push(`Spec saved to ${out}${target.mode === "app" ? " (from the live app document; unsaved app edits are included)" : ""}.`);
      }

      if (format === "json") {
        const body = { target: { id, name: model.root.name }, breadcrumb: crumb, shell: sec.shell.map((s) => ({ name: s.node.name, where: s.where, items: s.items })), sections: sec.sections.map((s) => ({ name: s.node.name, fixed: s.fixed, items: s.items })), ...toJson(model) };
        return wrap(target, [...notes, JSON.stringify(body)]);
      }

      if (format === "html-ref") {
        const safe = String(model.root.name ?? id).replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "") || id.replace(/\W+/g, "_");
        const base = savePath ? path.resolve(process.cwd(), savePath).replace(/\.json$/i, "") : path.join(path.dirname(target.file), safe);
        const htmlPath = `${base}.html`;
        const res = await run(`Export(${JSON.stringify([id])}, "html-css", ${JSON.stringify(htmlPath)}, { includeLayerNames: true })`);
        if (res.error) throw new ReadError(res.error);
        const html = fs.readFileSync(htmlPath, "utf8");
        const fixed = html.replace(/box-sizing:\s*content-box/g, "box-sizing: border-box").replace(/data-pencil-name=/g, "data-pen=");
        fs.writeFileSync(htmlPath, fixed);
        const fixes = (html.match(/box-sizing:\s*content-box/g) ?? []).length;
        return wrap(target, [
          ...notes,
          `Reference HTML written to ${htmlPath}. ${fixes} content-box declarations were changed to border-box (Pen's export otherwise renders padded frames wider than designed); layer names are in data-pen attributes.`,
          "Use it as a reference for structure and values, not as production code.",
        ]);
      }

      const lines = [
        `# ${model.root.name ?? id} (${id})`,
        ...crumb,
        "",
        "## App shell (inferred: docked to the top/bottom or named like a header/nav/tab bar)",
        ...(sec.shell.length ? sec.shell.map((s) => `- ${s.where}: ${s.node.name} — ${s.items.slice(0, 10).join(" ")}`) : ["- none"]),
        "",
        `## Sections in order${sec.scroll ? ` (scroll container "${sec.scroll.name}"; "fixed" sections sit outside it and do not scroll)` : ""}`,
        ...sec.sections.map((s, i) => `${i + 1}. ${s.node.name}${s.fixed ? " (fixed)" : ""} — ${s.items.slice(0, 12).join(" ")}${s.items.length > 12 ? ` … +${s.items.length - 12}` : ""}`),
        "",
        "## Outline",
        ...outline(model, { depth, maxLines, flavor, continueWith: (nodeId) => `inspect({ filePath: ${JSON.stringify(target.file)}, target: ${JSON.stringify(nodeId)} })` }),
      ];
      return wrap(target, [...notes, ...lines]);
    },
  );
  return { invalidate };
}
