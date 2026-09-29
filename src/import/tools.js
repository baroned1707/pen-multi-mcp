// Code -> design: import_ui rebuilds a running screen in the .pen; sync_status shows which design
// screens have been verified against the code, which are stale, and which have no route yet.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildModel } from "../design/model.js";
import { ReadError, readSubtree } from "../design/read.js";
import { colorTokens } from "../lint/rules.js";
import { readPng } from "../verify/image.js";
import { USAGE_SNIPPET, propertyNumbers } from "../verify/reverse.js";
import { nextStep } from "../guide.js";
import { projectMapping } from "../mapping/index.js";
import { designNodes } from "../verify/design.js";
import { SYNC_DIR, buildRecord, codeFilesChanged, diffText, factsDiff, frameDiff, readRecord, syncState } from "../sync/index.js";
import { frameFill } from "../verify/tools.js";
import { slug } from "../verify/tools.js";
import { buildSpecs, imageCropper, safeName, snippets, tokenOrHex } from "./build.js";
import { bestIcon, maskOf, renderCandidates } from "./icons.js";
import { crop } from "../verify/image.js";

const OUT_DIR = "design-verify";
const sha1 = (file) => (fs.existsSync(file) ? createHash("sha1").update(fs.readFileSync(file)).digest("hex") : null);
const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

export function registerImportTools({ tool, z, route, design, executeSnippet, optionalFilePath, capture, source, conventions, saver }) {
  /**
   * Auto-layout frames are kept only where the engine lays their children out where the page had
   * them (within 2px, relative to the frame); the others go back to layout "none" with each child
   * at its measured x/y.
   */
  async function checkAutoLayout(target, rootId, specs, ids) {
    const auto = specs.filter((sp) => sp.auto && ids[sp.key]);
    if (!auto.length) return { line: "Positions are absolute (layout none): no container could be imported as auto layout (flexbox, or children stacked with even gaps).", kept: 0, failed: 0 };
    await design.settleFonts?.(target, rootId); // auto layout measured in the real fonts
    const model = buildModel(await readSubtree(design.reader(target), rootId));
    const kidsOf = new Map();
    for (const sp of specs) if (sp.parent) (kidsOf.get(sp.parent) ?? kidsOf.set(sp.parent, []).get(sp.parent)).push(sp);
    const failed = [];
    for (const sp of auto) {
      const box = model.nodes.get(ids[sp.key])?.abs;
      const off = (kidsOf.get(sp.key) ?? []).some((k) => {
        const kb = model.nodes.get(ids[k.key])?.abs;
        return !box || !kb || Math.abs(kb.x - box.x - (k.props.x ?? 0)) > 2 || Math.abs(kb.y - box.y - (k.props.y ?? 0)) > 2;
      });
      if (off) failed.push(sp);
    }
    if (failed.length) {
      const ops = failed.flatMap((sp) => [
        `Update(${JSON.stringify(ids[sp.key])}, { layout: "none" })`,
        ...(kidsOf.get(sp.key) ?? []).filter((k) => ids[k.key]).map((k) => `Update(${JSON.stringify(ids[k.key])}, { x: ${k.props.x ?? 0}, y: ${k.props.y ?? 0} })`),
      ]);
      const out = await executeSnippet({ filePath: target.file, input: ops.join("\n") });
      if (out.isError) return { line: `Auto layout: ${auto.length - failed.length} frames kept; putting ${failed.length} back to absolute failed: ${out.content.map((c) => c.text ?? "").join(" ").slice(0, 200)}` };
    }
    return { line: `Auto layout: ${auto.length - failed.length} containers are auto-layout frames (flexbox, or children stacked with even gaps); ${failed.length} went back to absolute placement because the engine's layout did not reproduce the page within 2px; the other frames are absolute.`, kept: auto.length - failed.length, failed: failed.length };
  }

  /**
   * Icon elements of the capture recognised among the icons the document already uses, by shape.
   * Returns { map: Map(element index -> "library:icon"), tried }.
   */
  async function recogniseIcons(target, snapshot, shot, scale) {
    const els = snapshot.elements.filter((e) => e.icon && e.box.w >= 8 && e.box.h >= 8 && e.box.w <= 96 && e.box.h <= 96);
    if (!els.length) return { map: new Map(), tried: 0 };
    const used = await design.reader(target)(`const m = {}; Get((n) => { if (n.type === "icon" && n.library && n.icon) m[n.library + ":" + n.icon] = 1; return undefined; }); Print("I", JSON.stringify(Object.keys(m).slice(0, 150)))`);
    const icons = JSON.parse(/I (.*)/.exec(used.text ?? "")?.[1] ?? "[]").map((k) => k.split(":"));
    const candidates = await renderCandidates(icons, async (file, input) => {
      const out = await executeSnippet({ filePath: file, input });
      return out.content.map((c) => c.text ?? "").join("\n");
    });
    const map = new Map();
    for (const el of els) {
      const m = maskOf(crop(shot, { x: el.box.x * scale, y: el.box.y * scale, w: el.box.w * scale, h: el.box.h * scale }));
      const hit = m && bestIcon(m, candidates);
      if (hit) map.set(el.i, hit.key);
    }
    return { map, tried: els.length };
  }

  /** What is left to clean up in an import: raw colors and sizes no token has. */
  function cleanliness(specs) {
    const raw = (v) => typeof v === "string" && v.startsWith("#");
    const colors = specs.filter((x) => raw(x.props.fill) || raw(x.props.stroke)).length;
    const sizes = specs.filter((x) => typeof x.props.fontSize === "number" || typeof x.props.cornerRadius === "number").length;
    // Three or more sibling frames with the same size and the same kinds of children: likely one
    // component drawn several times (list rows, cards) that the code has not marked.
    const kids = new Map();
    for (const x of specs) if (x.parent) (kids.get(x.parent) ?? kids.set(x.parent, []).get(x.parent)).push(x);
    const repeated = [];
    for (const [, list] of kids) {
      const groups = new Map();
      for (const x of list) {
        if (x.props.type !== "frame") continue;
        const sig = `${Math.round(x.props.width)}x${Math.round(x.props.height)}:${(kids.get(x.key) ?? []).map((c) => c.props.type).join(",")}`;
        (groups.get(sig) ?? groups.set(sig, []).get(sig)).push(x);
      }
      for (const g of groups.values()) if (g.length >= 3) repeated.push(`${g.length}× "${g[0].props.name}"`);
    }
    return `Not on tokens yet: ${colors} node(s) with raw colors, ${sizes} with raw font sizes or radii (no token has those values).${repeated.length ? ` Repeated like a component but not one: ${repeated.slice(0, 5).join(", ")} — make it a component, or mark the code's with data-pen="<component id>".` : ""} Elements whose marker names a design component come in as its instances.`;
  }

  /**
   * Components the snapshot's markers name (by id or exact name): Map(marker -> { id, texts }),
   * texts being the component's visible text nodes in order, for instance overrides.
   */
  async function markedComponents(target, snapshot) {
    const markers = new Set(snapshot.elements.map((e) => e.marker && String(e.marker).replace(/^.*:id\//, "").replace(/^pen:/, "")).filter(Boolean));
    const out = new Map();
    if (!markers.size) return out;
    const { analysis } = await design.analysisOf(target);
    for (const c of analysis.components) {
      const key = markers.has(c.id) ? c.id : markers.has(c.name) ? c.name : null;
      if (!key) continue;
      const model = buildModel(await readSubtree(design.reader(target), c.id));
      const texts = [];
      const walk = (n) => {
        if (n.hidden) return;
        if (n.type === "text") texts.push({ id: n.id, content: n.resolved?.content ?? n.content });
        n.children.forEach(walk);
      };
      walk(model.root);
      out.set(key, { id: c.id, name: c.name, texts });
    }
    return out;
  }

  tool(
    "import_ui",
    "Use when a screen exists only in code and should become a design frame. Not for updating a frame that already exists (verify with direction \"code-to-design\"). Rebuild a running screen of the app as an editable frame in the .pen (code → design): painted boxes become frames (fill, radius, border), texts become text nodes (content, size, weight, family, color, line height), images and icons become crops of the screenshot, placed where the UI draws them; colors that equal a document token use the token. Use it to bring an implemented screen into the design, to start a design from existing code, or to compare side by side. Sources as for verify (web, probe, native). The new frame is placed right of the existing content.",
    {
      filePath: optionalFilePath,
      source: source.optional(),
      snapshot: z.string().optional().describe("Instead of source: a snapshot JSON written by capture."),
      name: z.string().optional().describe("Name of the new frame (default: from the page/route, plus \"(from code)\")."),
      width: z.number().positive().optional().describe("web: viewport width (default 390)."),
      height: z.number().positive().optional().describe("web: viewport height (default 844)."),
      colorScheme: z.enum(["light", "dark"]).optional().describe("web: prefers-color-scheme."),
      images: z.boolean().optional().describe("Crop images and icons from the screenshot into images/ next to the .pen (default true)."),
      theme: z.string().optional().describe("Theme whose token values colors are matched against (default: the first)."),
    },
    async ({ filePath: f, source: src, snapshot: snapPath, name, width = 390, height = 844, colorScheme, images = true, theme }) => {
      if (!src && !snapPath) throw new ReadError("Pass source (to capture now) or snapshot (a capture file).");
      const target = await route(f, { write: true });
      let snapshot;
      if (snapPath) snapshot = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), snapPath), "utf8"));
      else ({ snapshot } = await capture(src, { width, height, colorScheme, name: slug(`import-${src.url ?? src.platform ?? src.path}`) }));
      if (!Array.isArray(snapshot?.elements)) throw new ReadError("the snapshot has no elements (image-only sources cannot be imported).");
      if (!snapshot.elements.length) throw new ReadError("the capture found no elements; check the page or source.");

      const res = await design.reader(target)(`const v = GetVariables(); let right = 0; Get((n, c) => { c.skipChildren(); right = Math.max(right, (c.bounds.x || 0) + (c.bounds.width || 0)); return undefined; }); Print("CTX", JSON.stringify({ variables: v.variables || {}, themes: v.themes || {}, right }));`);
      if (res.error) throw new ReadError(res.error);
      const ctx = JSON.parse(/^CTX (.*)$/m.exec(res.text ?? "")[1]);
      // The frame is drawn in `theme` (its axis found in the document's themes), so tokens map in that theme.
      const axis = theme ? Object.entries(ctx.themes ?? {}).find(([, values]) => (values ?? []).includes(theme))?.[0] : null;
      if (theme && !axis) throw new ReadError(`theme "${theme}" is not one of the document's themes: ${JSON.stringify(ctx.themes)}`);
      const tokens = colorTokens(ctx.variables, theme);
      const shot = snapshot.screenshot && fs.existsSync(snapshot.screenshot) ? readPng(snapshot.screenshot) : null;
      const scale = snapshot.viewport?.scale ?? (shot ? shot.width / snapshot.viewport.w : 1);
      const prefix = `import-${slug(name ?? snapshot.url ?? snapshot.platform)}-${Date.now().toString(36)}`;
      const cropper = images && shot ? imageCropper({ img: shot, scale, penFile: target.file, prefix }) : null;
      const vw = snapshot.viewport?.w ?? width;
      const vh = shot ? shot.height / scale : snapshot.viewport?.h ?? height;
      const usage = await design.reader(target)(USAGE_SNIPPET);
      const numbers = propertyNumbers(ctx.variables, usage.text);
      const components = await markedComponents(target, snapshot);
      const iconMatches = shot ? await recogniseIcons(target, snapshot, shot, scale) : { map: new Map(), tried: 0 };
      const specs = buildSpecs(snapshot, { tokens, numbers, components, images: cropper, icons: iconMatches.map, frameHeight: vh });
      const frameName = safeName(name ?? `${snapshot.url ? new URL(snapshot.url).pathname.replace(/^\/+/, "") || "home" : snapshot.platform ?? "screen"} (from code)`);
      const pageBg = tokenOrHex(snapshot.pageBg, tokens) ?? "#FFFFFF";
      const screen = { type: "frame", name: frameName, x: Math.ceil(ctx.right + 200), y: 0, width: Math.round(vw), height: Math.round(vh), layout: "none", clip: true, fill: pageBg, ...(axis ? { theme: { [axis]: theme } } : {}) };
      let rootId = null;
      let created = 0;
      let ids = {};
      let iconFallbacks = 0;
      for (const input of snippets({ screen, specs })) {
        const out = await executeSnippet({ filePath: target.file, input });
        const t = out.content.map((c) => c.text ?? "").join("\n");
        if (out.isError) throw new ReadError(`import stopped after ${created} of ${specs.length} nodes${rootId ? ` (partial frame ${rootId})` : ""}: ${t.slice(0, 400)}`);
        rootId ??= /ROOT (\S+)/.exec(t)?.[1];
        const keys = /^KEYS (.*)$/m.exec(t);
        if (keys) ids = JSON.parse(keys[1]);
        if (/CLEAN 1/.test(t)) continue;
        const done = /DONE (\d+) (\d+)/.exec(t);
        if (done) (created = Number(done[1])), (iconFallbacks += Number(done[2]));
      }
      const layout = await checkAutoLayout(target, rootId, specs, ids);
      return design.wrap(target, [
        `Imported ${created} nodes into a new frame "${frameName}" (${rootId}) at x ${screen.x}, ${Math.round(vw)}×${Math.round(vh)}.`,
        `${specs.filter((s) => s.props.type === "text").length} texts, ${specs.filter((s) => s.props.fill?.type === "image").length} image crops, ${specs.filter((s) => typeof s.props.fill === "string" && s.props.fill.startsWith("$")).length} fills on tokens, ${specs.filter((s) => s.props.type === "ref").length} component instances${axis ? `, drawn in ${axis} ${theme}` : ""}.`,
        cleanliness(specs),
        ...(snapshot.truncated ? ["The page has more elements than a capture keeps (6,000): the import is partial; import a narrower state or screen."] : []),
        layout.line,
        iconMatches.tried ? `Icons: ${iconMatches.map.size - iconFallbacks} of ${iconMatches.tried} icon elements are icon nodes (recognised among the document's icons)${iconFallbacks ? `; ${iconFallbacks} rejected by the engine, kept as crops` : ""}; the rest are crops.` : "",
        nextStep({ state: "imported", id: rootId }),
        "Name the layers, replace crops with icons or components where they exist, and turn the remaining absolute sections into auto layout where the design should flow. lint the frame to see what is left.",
      ]);
    },
  );

  tool(
    "sync_status",
    "Use when you need to know where design and code stand, screen by screen, and what to run next. Where design and code stand: every screen × width × theme of the document with its route (from .pen-multi.json routes), its last verify verdict and age, and whether the design changed since (stale). Lists what to verify next.",
    { filePath: optionalFilePath, maxLines: z.number().int().min(10).max(2000).optional().describe("Rows listed (default 200)."), maxReads: z.number().int().min(0).max(200).optional().describe("Frames whose design changed are read again to list what changed (default 20).") },
    async ({ filePath: f, maxLines = 200, maxReads = 20 }) => {
      const target = await route(f);
      const { analysis } = await design.analysisOf(target);
      const conv = conventions(target.file);
      // The design as saved: wait for pending background saves before hashing it.
      await saver?.flush(target.file).catch(() => {});
      const current = target.mode === "app" ? null : sha1(target.file);
      const dir = path.join(process.cwd(), OUT_DIR);
      const reports = new Map();
      for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!n.endsWith(".json")) continue;
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
          if (r?.target?.id && r.pen?.path === target.file && (!reports.has(r.target.id) || reports.get(r.target.id).generatedAt < r.generatedAt)) reports.set(r.target.id, r);
        } catch {}
      }
      // Sync records (design-sync/ next to the .pen): the last MATCH of each frame.
      const records = new Map();
      const syncDir = path.join(path.dirname(target.file), SYNC_DIR);
      for (const n of fs.existsSync(syncDir) ? fs.readdirSync(syncDir) : []) {
        const rec = n.endsWith(".json") ? readRecord(path.join(syncDir, n)) : null;
        if (rec?.frame?.id) records.set(rec.frame.id, rec);
      }
      const mapping = records.size ? projectMapping({ penFile: target.file, conv, variables: {}, themes: {} }) : null;
      let reads = 0;
      const rows = [];
      for (const row of analysis.matrix.rows) {
        for (const [w, cells] of Object.entries(row.cells)) {
          for (const c of cells) {
            const r = reports.get(c.id);
            const routeFor = [c.name, row.screen, row.code].map((k) => conv.routes?.[k]).find(Boolean);
            const rec = records.get(c.id);
            let state, changes = "";
            if (rec) {
              // Design side: an unchanged .pen is proof; otherwise read the frame again (bounded).
              let designChanged = false, designText = "";
              if (!current || rec.pen?.sha1 !== current) {
                if (reads < maxReads) {
                  reads++;
                  await design.settleFonts?.(target, c.id);
                  const model = buildModel(await readSubtree(design.reader(target), c.id));
                  const now = buildRecord({ penFile: target.file, penSha: current, frame: rec.frame, design: designNodes(model), pairs: [] });
                  const dd = factsDiff(rec.nodes, now.nodes, "design");
                  dd.changed.unshift(...frameDiff(rec.frame, { name: rec.frame.name, fill: frameFill(model.root) }));
                  designChanged = dd.added.length + dd.removed.length + dd.changed.length > 0;
                  designText = diffText(dd, 4);
                } else designText = "not read (maxReads)";
              }
              // Code side: the files carrying this frame's markers, changed since the record's commit.
              const files = [...new Set(Object.entries(rec.nodes).map(([address, n]) => mapping?.locate({ id: n.id, address, name: address.split("/").pop() })?.file).filter(Boolean))];
              const changedFiles = codeFilesChanged(rec, files);
              const codeChanged = Boolean(changedFiles?.length);
              state = syncState({ record: rec, designChanged, codeChanged });
              changes = [designChanged && `design: ${designText}`, codeChanged && `code: ${changedFiles.join(", ")}`, changedFiles === null && "code: not checked (no markers, or the recorded commit is not in this history) — verify checks it"].filter(Boolean).join(" · ");
            } else {
              // No record yet (verified before sync records existed, or never matched).
              const stale = r && current && r.pen?.sha1 && r.pen.sha1 !== current;
              state = !r ? "never" : r.summary.verdict === "match" ? (stale ? "match (stale)" : "match") : "differs";
            }
            rows.push({ c, row, w, r, route: routeFor, state, changes });
          }
        }
      }
      const count = (s) => rows.filter((x) => x.state === s).length;
      const STATES = ["in-sync", "design-changed", "code-changed", "both-changed", "match", "match (stale)", "differs", "never"];
      const lines = [
        `# sync status: ${rows.length} screen frames`,
        STATES.filter((s) => count(s)).map((s) => `${s} ${count(s)}`).join(" · "),
        "",
        "screen | state | width | theme | route | last verify | changed since the last match",
      ];
      for (const x of rows.slice(0, maxLines)) {
        lines.push(`${x.row.screen}${x.row.state ? ` — ${x.row.state}` : ""} | ${x.state} | ${x.w} | ${x.c.theme ?? "–"} | ${x.route ?? "–"} | ${x.r ? `${x.r.summary.high} high, ${x.r.summary.medium} medium, ${ago(x.r.generatedAt)}` : "–"} | ${x.changes || "–"}`);
      }
      if (rows.length > maxLines) lines.push(`… ${rows.length - maxLines} more rows.`);
      // What to run next, most urgent first: conflicts, then either side changed, then unchecked.
      const order = ["both-changed", "design-changed", "code-changed", "differs", "match (stale)", "never"];
      const next = rows.filter((x) => order.includes(x.state) && (x.route || x.state === "both-changed")).sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state)).slice(0, 8);
      if (next.length) {
        lines.push("", "## Next");
        for (const x of next) {
          const v = (extra = "") => `verify({ target: ${JSON.stringify(x.c.id)}, source: { kind: "web" }${extra} })`;
          if (x.state === "both-changed") lines.push(`- ${v()}  // ${x.c.name}: both sides changed — verify tells whether they touched the same nodes (then ask the user which side wins) or different ones (then carry each change across)`);
          else if (x.state === "code-changed") lines.push(`- ${v(', direction: "code-to-design"')}  // ${x.c.name}: code changed — if the design should follow; else fix the code and verify`);
          else lines.push(`- ${v()}  // ${x.c.name}: ${x.state}`);
        }
      }
      if (!Object.keys(conv.routes ?? {}).length) lines.push("", 'No routes: add { "baseUrl": "http://localhost:5173", "routes": { "<screen>": "/path" } } to .pen-multi.json next to the .pen so verify can find each screen\'s page.');
      return design.wrap(target, lines);
    },
  );
}
