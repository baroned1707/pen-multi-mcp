// The design-context tools: overview (big picture of a document) and inspect (one screen or node
// as data an agent can implement from). Both only read; they never mark a file dirty or save it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildModel } from "./model.js";
import { outline, sectionLines, sections, textDefaults, toJson } from "./inspect.js";
import { projectMapping } from "../mapping/index.js";
import { pickBase, variantLines } from "./variants.js";
import { nextStep } from "../guide.js";
import { crop, pngBuffer, readPng, resize } from "../verify/image.js";
import { analyze, renderOverview } from "./overview.js";
import { ReadError, readOverview, readSubtree } from "./read.js";

const APP_CACHE_MS = 60_000;

/**
 * `.pen-multi.json` next to the .pen: { screenPattern, flows: ["docs/flow.json", ...],
 * baseUrl: "http://localhost:5173", routes: { "<screen name or code>": "/path" } }.
 */
export function conventions(file) {
  const p = path.join(path.dirname(file), ".pen-multi.json");
  if (!fs.existsSync(p)) return {};
  const conf = JSON.parse(fs.readFileSync(p, "utf8"));
  const flowEdges = [];
  for (const f of conf.flows ?? []) {
    const doc = JSON.parse(fs.readFileSync(path.resolve(path.dirname(p), f), "utf8"));
    flowEdges.push(...(doc.edges ?? []));
  }
  return { screenPattern: conf.screenPattern, flowEdges, baseUrl: conf.baseUrl, routes: conf.routes ?? {}, states: conf.states ?? {}, tokens: conf.tokens, components: conf.components, brief: conf.brief };
}

const fileHash = (file) => (fs.existsSync(file) ? createHash("sha1").update(fs.readFileSync(file)).digest("hex") : null);
const mtime = (file) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);

export function registerDesignTools({ tool, z, route, app, pool, saver, timings, ok, fail, fromApp, textOf, optionalFilePath }) {
  const cache = new Map(); // file -> { key, analysis }
  const generations = new Map(); // file -> count of writes seen through this server
  const invalidate = (file) => {
    cache.delete(file);
    generations.set(file, (generations.get(file) ?? 0) + 1);
  };
  // While this server has a file open headlessly, its content changes only through this server, so
  // the write count identifies it (a background save changing the mtime is not a new version).
  const cacheKey = (target) => {
    if (target.mode === "app") return `app:${Math.floor(Date.now() / APP_CACHE_MS)}`;
    const session = pool.sessions.get(target.file);
    return session ? `session:${session.openedAt}:${generations.get(target.file) ?? 0}` : `disk:${mtime(target.file)}`;
  };

  /** A `run(input)` for read-only snippets on the routed document. */
  const reader = (target) =>
    target.mode === "app"
      ? async (input) => {
          const res = await timings.time("call", () => app.call("execute", { filePath: target.file, input }));
          return res.isError ? { error: textOf(res) } : { text: textOf(res) };
        }
      : (input) => pool.use(target.file, (session) => timings.time("call", () => session.shell.call("execute", { input })));

  async function analysisOf(target, { refresh = false, cachedOnly = false } = {}) {
    const key = cacheKey(target);
    const hit = cache.get(target.file);
    if (!refresh && hit && hit.key === key) return { ...hit, cached: true };
    if (cachedOnly) return null;
    const gen = generations.get(target.file) ?? 0;
    const conv = conventions(target.file);
    const { data, stats, unavailable } = await readOverview(reader(target));
    // Reading opens a headless session, which changes the key; store it under the key the next
    // lookup will compute. The generation is the one from before the read, so a write that
    // lands meanwhile still makes the next lookup miss.
    const session = target.mode === "app" ? null : pool.sessions.get(target.file);
    const storeKey = session ? `session:${session.openedAt}:${gen}` : cacheKey(target);
    const entry = { key: storeKey, analysis: analyze(data, stats, conv), unavailable, readAt: new Date().toISOString() };
    cache.set(target.file, entry);
    return { ...entry, cached: false };
  }

  const wrap = (target, lines) =>
    target.mode === "app" ? fromApp({ content: [{ type: "text", text: lines.join("\n") }] }, target) : ok(lines.join("\n"), [], target.file);

  tool(
    "overview",
    `Use when starting design work on a .pen: every screen, state, width, theme, component and token at a glance. Not for one screen's details (inspect). The big picture of a .pen document, before designing or implementing anything: every screen as a matrix (screen + state × width, with the themes each cell is drawn in, empty cells shown), canvas bands in reading order, flows between screens (inferred from arrows, or declared), components with where they are used, the type and spacing scales in use, raw colors, and the intent notes left in the file. Use focus to zoom into one screen or code (e.g. "S3", "Checkout"), which also lists each frame's node id for inspect. A .pen-multi.json next to the file can declare { "screenPattern": "<regex with named groups screen, state, width, theme>", "flows": ["path/to/flow.json"] }.`,
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
  const framesOf = (analysis) => analysis.matrix.rows.flatMap((r) => Object.entries(r.cells).flatMap(([w, cs]) => cs.map((c) => ({ ...c, width: w, row: r }))));
  const variant = (c) => (c.width || c.theme ? ` (${[c.width, c.theme].filter(Boolean).join(", ")})` : "");

  async function resolveTarget(target, wanted, { refreshed = false } = {}) {
    // A node id is read directly; the document-wide analysis is only used if already cached, so
    // inspecting by id right after an edit does not re-read the whole document.
    if (!refreshed && /^[\w-]+(\/[\w-]+)*$/.test(wanted)) {
      try {
        const raw = await readSubtree(reader(target), wanted);
        const cached = await analysisOf(target, { cachedOnly: true });
        const frame = cached ? framesOf(cached.analysis).find((c) => c.id === wanted) ?? null : null;
        return { id: wanted, frame, analysis: cached?.analysis ?? null, raw };
      } catch (err) {
        // A name that looks like an id: Get resolves names too, and may find several.
        if (!/can't find node|not found|does not exist|multiple descendants/i.test(err.message)) throw err;
      }
    }
    const { analysis } = await analysisOf(target, { refresh: refreshed });
    const frames = framesOf(analysis);
    const exact = frames.filter((c) => c.id === wanted || c.name === wanted);
    if (exact.length === 1) return { id: exact[0].id, frame: exact[0], analysis };
    const comp = analysis.components.filter((c) => c.name === wanted);
    if (comp.length === 1) return { id: comp[0].id, frame: null, analysis };
    const lower = wanted.toLowerCase();
    // Exact name matches win over partial ones; two frames with the same name are still ambiguous.
    const loose = exact.length ? exact : frames.filter((c) => c.row.code?.toLowerCase() === lower || c.name.toLowerCase().includes(lower));
    if (loose.length === 1) return { id: loose[0].id, frame: loose[0], analysis };
    if (loose.length > 1) {
      const err = new ReadError(`"${wanted}" matches ${loose.length} frames; pass one id (or width/theme where the tool takes them):\n` + loose.slice(0, 30).map((c) => `- ${c.name}${variant(c)} → ${c.id}`).join("\n"));
      err.candidates = loose;
      err.analysis = analysis;
      throw err;
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
    if (frame && analysis) {
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

  /** When a frame was last verified against an older version of the design: its date, else null. */
  function staleSince(target, id) {
    if (target.mode === "app") return null;
    const dir = path.join(process.cwd(), "design-verify");
    const tag = createHash("sha1").update(`${target.file}\n${id}`).digest("hex").slice(0, 6);
    let latest = null;
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith(`-${tag}.json`)) continue;
        const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
        if (r?.target?.id === id && (!latest || r.generatedAt > latest.generatedAt)) latest = r;
      }
    } catch {
      return null;
    }
    const now = fileHash(target.file);
    return latest?.pen?.sha1 && now && latest.pen.sha1 !== now ? latest.generatedAt : null;
  }

  /**
   * The engine loads a font the first time it lays out text in it (~2 s later), measuring in a
   * fallback font until then. Measuring tools call this first: a frame using a font family this
   * editor has not settled yet waits until FONT_SETTLE_MS after that first layout and until its
   * text sizes stop changing (at most ~8 s). Settled families are remembered per editor, so this
   * costs one read afterwards; the app is never delayed. Returns true when it waited.
   */
  const FONT_SETTLE_MS = Number(process.env.PEN_MULTI_FONT_SETTLE_MS ?? 2500);
  async function settleFonts(target, id) {
    const s = target.mode === "app" || !FONT_SETTLE_MS ? null : pool.sessions.get(target.file); // 0 turns it off
    if (!s) return false;
    const run = reader(target);
    const q = JSON.stringify(id);
    const read = async () => {
      const t = (await run(`Print("F", JSON.stringify(Get(${q}, (n, c) => n.type === "text" ? [String(n.fontFamily ?? ""), Math.round(c.bounds.width), Math.round(c.bounds.height)] : undefined).filter(Boolean)))`)).text ?? "";
      try {
        return JSON.parse(/F (.*)/.exec(t)?.[1] ?? "[]");
      } catch {
        return [];
      }
    };
    const started = Date.now();
    let prev = await read(); // this layout starts loading the frame's fonts
    s.fontsSettled ??= new Set();
    const families = [...new Set(prev.map((x) => x[0]))];
    if (!families.some((f) => !s.fontsSettled.has(f))) return false;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const key = (list) => JSON.stringify(list);
    while (Date.now() - started < 8000) {
      await wait(Date.now() - started < FONT_SETTLE_MS ? FONT_SETTLE_MS - (Date.now() - started) : 500);
      const now = await read();
      const stable = key(now) === key(prev);
      prev = now;
      if (stable && Date.now() - started >= FONT_SETTLE_MS) break;
    }
    for (const f of families) s.fontsSettled.add(f);
    return true;
  }

  // Renders already attached in this session: file|id|design hash.
  const shown = new Set();
  const MAX_EDGE = 1568; // larger images are scaled down by the model anyway

  /**
   * A labelled render of a node for inspect: attached the first time the node (at this version of
   * the design) is inspected in the session, or as `want` says. Tall frames show their top part.
   * Never fails the call: a render that does not work is simply left out.
   */
  async function designImage(target, run, id, model, want) {
    const key = `${target.file}|${id}|${target.mode === "app" ? "live" : fileHash(target.file)}`;
    if (want === false || (want === undefined && shown.has(key))) return null;
    try {
      // A temp folder: inspect never writes into the project on its own.
      const dir = path.join(os.tmpdir(), "pen-multi-render", createHash("sha1").update(target.file).digest("hex").slice(0, 10));
      fs.mkdirSync(dir, { recursive: true });
      const out = await run(`Export(${JSON.stringify([id])}, "png", ${JSON.stringify(dir)})`);
      if (out.error) return null;
      const file = /Exported (.+\.png)/.exec(out.text ?? "")?.[1]?.trim() ?? path.join(dir, `${id}.png`);
      if (!fs.existsSync(file)) return null;
      let img = readPng(file);
      let note = "";
      if (img.height > img.width * 2.2) {
        const h = Math.round(img.width * 2);
        const scale = img.height / (model.root.abs?.h || img.height);
        img = crop(img, { x: 0, y: 0, w: img.width, h });
        note = `, top ${Math.round(h / scale)}px of ${Math.round(model.root.abs?.h ?? 0)}px; inspect a section with image: true for the rest`;
      }
      // At the design's own size (renders are 2x): the image is for the overall look, and every
      // extra pixel is tokens resent on each later turn.
      const designW = Math.round(model.root.abs?.w ?? img.width);
      if (img.width > designW) img = resize(img, designW);
      if (Math.max(img.width, img.height) > MAX_EDGE) img = resize(img, Math.round((img.width * MAX_EDGE) / Math.max(img.width, img.height)));
      shown.add(key);
      return {
        label: `Design render: ${model.root.name ?? id} (${id})${note}. Use it for the overall look; take every number from the outline.`,
        image: { type: "image", data: pngBuffer(img).toString("base64"), mimeType: "image/png" },
      };
    } catch {
      return null;
    }
  }

  /**
   * What an instance of a component can change: slots, the descendants real instances override
   * (and how often), its family (same name prefix), instance count and code mapping.
   */
  async function componentApi(target, run, model, map) {
    const id = model.root.id;
    const lines = [`## Component API: ${model.root.name ?? id}`];
    const slots = [...model.nodes.values()].filter((n) => n.slot);
    lines.push(`- Slots: ${slots.length ? slots.map((n) => `${n.name ?? n.id} (${n.id})`).join(", ") : "none"}`);
    const res = await run(`Print("O", JSON.stringify(Get((n) => n.type === "ref" && n.ref === ${JSON.stringify(id)} ? Object.keys(n.descendants || {}) : undefined).filter(Boolean)))`);
    const lists = res.error ? [] : JSON.parse(/O (.*)/.exec(res.text ?? "")?.[1] ?? "[]");
    const freq = new Map();
    for (const keys of lists) for (const k of new Set(keys)) freq.set(k, (freq.get(k) ?? 0) + 1);
    const named = [...freq].sort((a, b) => b[1] - a[1]).map(([k, c]) => {
      const n = model.nodes.get(k) ?? model.nodes.get(k.split("/").at(-1));
      return `${n ? `${n.name ?? n.id} [${n.type}]` : k} in ${c}`;
    });
    lines.push(`- Instances: ${lists.length}${lists.length ? `; overridden: ${named.length ? named.slice(0, 12).join(", ") : "nothing"} (of ${lists.length})` : ""}`);
    const cached = await analysisOf(target, { cachedOnly: true });
    const cut = (model.root.name ?? "").lastIndexOf("/");
    if (cached && cut > 0) {
      const prefix = model.root.name.slice(0, cut + 1);
      const family = cached.analysis.components.filter((c) => (c.name ?? "").startsWith(prefix) && c.id !== id);
      if (family.length) lines.push(`- Family ${prefix}*: ${family.map((c) => `${c.name} (${c.id}, ${c.instances} instances)`).join(", ")} — in code, often one component with a variant prop`);
    }
    const code = map.component(id);
    lines.push(`- Code: ${code ? `${code.code} (${code.file}${code.line ? `:${code.line}` : ""})` : `not mapped — mark the code definition with data-pen="${id}" (or "pen:${id}")`}`);
    return lines;
  }

  /** Components and tokens of a model mapped to the project's code, with what is missing. */
  function codeMapping(target, model) {
    const used = new Map();
    for (const n of model.nodes.values()) if (n.component && !n.hidden) used.set(n.component.id, { id: n.component.id, name: n.component.name, instances: (used.get(n.component.id)?.instances ?? 0) + 1 });
    const conv = conventions(target.file);
    const m = projectMapping({ penFile: target.file, conv, variables: model.variables, themes: model.themes, components: [...used.values()] });
    const lines = ["## Code"];
    const mapped = [...m.components].filter(([, c]) => !c.problem);
    if (used.size) {
      lines.push(`- Components: ${mapped.length} of ${used.size} used here map to code${mapped.length ? `: ${mapped.map(([id, c]) => `${used.get(id)?.name} → ${c.code} (${c.file}${c.line ? `:${c.line}` : ""})`).join(", ")}` : ""}.`);
      for (const [id, c] of m.components) if (c.problem) lines.push(`- ${used.get(id)?.name}: .pen-multi.json components entry — ${c.problem}.`);
      if (m.components.unmapped.length) lines.push(`- Not mapped: ${m.components.unmapped.map((c) => `${c.name} ×${c.instances} (id ${c.id}${c.usages > 1 ? `; its name marks ${c.usages} places in the code — usages, not the definition` : c.near ? `; a marker with its name sits in ${c.near}, which is not this component` : ""})`).join(", ")}. If the code has it, mark its definition with data-pen="<id>" (or testID/Key "pen:<id>"), or add .pen-multi.json { "components": { "<id>": { "code": "Name", "file": "path" } } }; else build it once and reuse it.`);
    } else lines.push("- No component instances here.");
    if (m.tokens.size) lines.push(`- Tokens are shown under their code names (${m.tokens.size} mapped${m.tokens.ambiguous.length ? `; ambiguous, shown as design tokens: ${m.tokens.ambiguous.map((a) => `${a.token} = ${a.candidates.join(" or ")}`).join(", ")}` : ""}).`);
    else lines.push('- Tokens are shown as design variables: add .pen-multi.json { "tokens": { "file": "<the code\'s token file>" } } to see the code\'s names (matched by name, then by a unique value).');
    lines.push(...m.notes.map((x) => `- ${x}`));
    return { lines, codeName: m.codeName, component: (id) => { const c = m.component(id); return c && !c.problem ? c : null; }, mapping: m };
  }

  tool(
    "inspect",
    `Use when implementing or checking one screen or component: the design as data to build from. Not for a picture of it (the first call attaches one) or for the whole file (overview). Read one screen or node of a .pen design as data to implement from, instead of looking at screenshots: where it sits (other widths, states, themes, flows in and out, components used), its sections in order with the app shell (docked header, tab bar) marked, and an outline with one line per node: absolute position and size, sizing (fill/hug/fixed), auto-layout, colors as token name plus the value in every theme, typography with line height in px, components and overrides, clipping. Repeated rows are collapsed. flavor adds code hints per node (tailwind, css or react-native) following pen.dev's layout rules. format "json" returns the full data for scripts; "html-ref" writes Pen's HTML export with its box-sizing bug fixed and layer names as data-pen. savePath writes the JSON (with the .pen's hash) so it can be re-read after context compaction.`,
    {
      filePath: optionalFilePath,
      target: z.string().describe("Node id, or a screen name / code (e.g. \"S3 · Trang tin · sáng\", \"M5\"). Use overview with focus to find ids."),
      depth: z.number().int().min(0).max(40).optional().describe("Outline depth (default 8)."),
      maxLines: z.number().int().min(20).max(3000).optional().describe("Outline line limit (default 400)."),
      flavor: z.enum(["tailwind", "css", "react-native"]).optional().describe("Add per-node code hints in this flavor."),
      format: z.enum(["outline", "json", "html-ref"]).optional().describe("outline (default), json, or html-ref."),
      detail: z.enum(["summary", "normal", "full"]).optional().describe('outline detail: "normal" (default) shows values in the frame\'s own theme, states shared text defaults once and keeps whole sections under maxLines; "full" also lists every theme\'s value on every line; "summary" gives only the sections.'),
      savePath: z.string().optional().describe("Write the JSON spec here (relative to the agent's working directory), e.g. design-spec/home.json."),
      image: z.boolean().optional().describe("Attach a render of the node before the outline. Default: only the first time this node (at this version of the design) is inspected in this session."),
    },
    async ({ filePath: f, target: wanted, depth = 8, maxLines = 400, flavor, format = "outline", detail = "normal", savePath, image }) => {
      const target = await route(f);
      // A screen name matching several frames (widths × themes × states): the outline shows one
      // base frame and the others as differences from it.
      let resolved, variantsOf = null;
      try {
        resolved = await resolveTarget(target, wanted);
      } catch (err) {
        if (!err.candidates || format !== "outline") throw err;
        // Only frames of the screen named: its own rows, and screens named "<it> · …" / "<it> — …"
        // (states the names add). A partial match ("Map" in "Sitemap") stays ambiguous.
        const same = (c) => c.row?.screen === wanted || c.row?.code === wanted || c.row?.screen?.startsWith(`${wanted} · `) || c.row?.screen?.startsWith(`${wanted} — `);
        const own = err.candidates.filter(same);
        if (own.length < 2 || !err.candidates.some((c) => c.row?.screen === wanted || c.row?.code === wanted)) throw err;
        const base = pickBase(own);
        resolved = { id: base.id, frame: base, analysis: err.analysis };
        variantsOf = own.filter((c) => c.id !== base.id);
      }
      const { id, frame, analysis } = resolved;
      const run = reader(target);
      // Text sizes are right only once the engine's fonts have loaded.
      const waited = await settleFonts(target, id);
      const raw = (!waited && resolved.raw) || (await readSubtree(run, id));
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
          if (!(prev && typeof prev.pen === "object" && prev.pen && "sha1" in prev.pen)) throw new ReadError(`${out} exists and is not an inspect spec; refusing to overwrite it.`);
        }
        // Hash what is on disk after pending saves, so the hash matches the data just read.
        await saver?.flush(target.file).catch(() => {});
        const unsaved = Boolean(pool.sessions.get(target.file)?.dirty);
        const hash = fileHash(target.file);
        if (prev && prev.pen.sha1 && prev.pen.sha1 !== hash) notes.push(`The previous spec at ${out} was stale: the design changed since ${prev.generatedAt}.`);
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
        const full = toJson(model);
        // Inline JSON is capped (a 4,000-node screen is ~1 MB); the saved spec is complete.
        const cap = maxLines;
        const body = {
          target: { id, name: model.root.name },
          breadcrumb: crumb,
          shell: sec.shell.map((s) => ({ name: s.node.name, where: s.where, items: s.items })),
          sections: sec.sections.slice(0, 200).map((s) => ({ id: s.node.id, name: s.node.name ?? s.node.type, fixed: s.fixed, items: s.items.slice(0, 30) })),
          truncatedSections: sec.sections.length > 200 ? sec.sections.length - 200 : undefined,
          ...full,
          nodes: full.nodes.slice(0, cap),
          truncatedNodes: full.nodes.length > cap ? full.nodes.length - cap : undefined,
        };
        if (body.truncatedNodes) notes.push(`${body.truncatedNodes} nodes are not included inline: pass savePath for the complete spec, or inspect a child id.`);
        return wrap(target, [...notes, JSON.stringify(body)]);
      }

      if (format === "html-ref") {
        const safe = String(model.root.name ?? id).replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "") || id.replace(/\W+/g, "_");
        // Written into its own folder so a screen called "index" never replaces a project's index.html.
        const base = savePath ? path.resolve(process.cwd(), savePath).replace(/\.json$/i, "") : path.join(path.dirname(target.file), "design-ref", safe);
        const htmlPath = `${base}.html`;
        if (fs.existsSync(htmlPath) && !fs.readFileSync(htmlPath, "utf8").includes("data-pen=")) {
          throw new ReadError(`${htmlPath} exists and was not written by inspect; refusing to overwrite it. Pass savePath to choose another place.`);
        }
        fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
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
        `# ${model.root.name ?? model.root.type} (${id})`,
        ...crumb,
        "",
        "## App shell (inferred: named like a header/footer/nav/tab bar/sidebar, or pinned along an edge)",
        ...(sec.shell.length ? sec.shell.map((s) => `- ${s.where}: ${s.node.name ?? s.node.type} — ${s.items.slice(0, 10).join(" ")}`) : ["- none"]),
        "",
        `## Sections in order${sec.scroll ? ` (scroll container "${sec.scroll.name ?? sec.scroll.type}"; "fixed" sections sit outside it and do not scroll)` : ""}${sec.wrapper ? ` (inside wrapper "${sec.wrapper.name ?? sec.wrapper.type}")` : ""}`,
        ...sectionLines(sec, { max: Math.max(40, Math.floor(maxLines / 10)) }),
        "",
      ];
      const more = (nodeId) => `inspect({ filePath: ${JSON.stringify(target.file)}, target: ${JSON.stringify(nodeId)} })`;
      if (detail === "summary") {
        lines.push("", `Outline left out (detail "summary"): inspect with detail "normal", or one section by its id.`);
      } else if (detail === "full") {
        lines.push("", "## Outline", ...outline(model, { depth, maxLines, flavor, continueWith: more }));
      } else {
        const map = codeMapping(target, model);
        if (model.root.reusable) lines.push("", ...(await componentApi(target, run, model, map)));
        lines.push("", ...map.lines);
        const o = { compact: true, codeName: map.codeName, component: map.component };
        const defaults = textDefaults(model, o);
        lines.push("", `## Outline (values in this frame's theme${defaults ? "; text defaults below" : ""}; detail "full" lists every theme)`, ...(defaults ? [defaults.line] : []), ...outline(model, { depth, maxLines, flavor, continueWith: more, ...o, defaults }));
      }
      if (format === "outline") {
        const stale = staleSince(target, id);
        if (stale) lines.push("", `Note: the design of this frame changed since its last verify (${stale}); the code may still show the old version.`);
        lines.push("", nextStep({ state: "inspected", id }));
      }
      if (variantsOf) {
        const MAX_VARIANTS = 12;
        const others = [];
        for (const c of variantsOf.slice(0, MAX_VARIANTS)) others.push({ frame: c, model: buildModel(await readSubtree(run, c.id)) });
        lines.push("", ...variantLines(frame, model, others, { more }));
        if (variantsOf.length > MAX_VARIANTS) lines.push(`… ${variantsOf.length - MAX_VARIANTS} more frames of "${wanted}": ${variantsOf.slice(MAX_VARIANTS).map((c) => c.id).join(", ")}`);
        lines.unshift(`"${wanted}" is ${variantsOf.length + 1} frames: ${frame.name} (${id}) in full, the others as differences below.`);
      }
      const res = wrap(target, [...notes, ...lines]);
      const shot = await designImage(target, run, id, model, image);
      if (shot) res.content.splice(1, 0, { type: "text", text: shot.label }, shot.image);
      return res;
    },
  );
  return { invalidate, resolveTarget, reader, wrap, analysisOf, settleFonts };
}
