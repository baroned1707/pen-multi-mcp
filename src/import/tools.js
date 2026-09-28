// Code -> design: import_ui rebuilds a running screen in the .pen; sync_status shows which design
// screens have been verified against the code, which are stale, and which have no route yet.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ReadError } from "../design/read.js";
import { colorTokens } from "../lint/rules.js";
import { readPng } from "../verify/image.js";
import { slug } from "../verify/tools.js";
import { buildSpecs, imageCropper, safeName, snippets, tokenOrHex } from "./build.js";

const OUT_DIR = "design-verify";
const sha1 = (file) => (fs.existsSync(file) ? createHash("sha1").update(fs.readFileSync(file)).digest("hex") : null);
const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

export function registerImportTools({ tool, z, route, design, executeSnippet, optionalFilePath, capture, source, conventions, saver }) {
  tool(
    "import_ui",
    "Rebuild a running screen of the app as an editable frame in the .pen (code → design): painted boxes become frames (fill, radius, border), texts become text nodes (content, size, weight, family, color, line height), images and icons become crops of the screenshot, placed where the UI draws them; colors that equal a document token use the token. Use it to bring an implemented screen into the design, to start a design from existing code, or to compare side by side. Sources as for verify (web, probe, native). The new frame is placed right of the existing content.",
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
      const specs = buildSpecs(snapshot, { tokens, images: cropper, frameHeight: vh });
      const frameName = safeName(name ?? `${snapshot.url ? new URL(snapshot.url).pathname.replace(/^\/+/, "") || "home" : snapshot.platform ?? "screen"} (from code)`);
      const pageBg = tokenOrHex(snapshot.pageBg, tokens) ?? "#FFFFFF";
      const screen = { type: "frame", name: frameName, x: Math.ceil(ctx.right + 200), y: 0, width: Math.round(vw), height: Math.round(vh), layout: "none", clip: true, fill: pageBg, ...(axis ? { theme: { [axis]: theme } } : {}) };
      let rootId = null;
      let created = 0;
      for (const input of snippets({ screen, specs })) {
        const out = await executeSnippet({ filePath: target.file, input });
        const t = out.content.map((c) => c.text ?? "").join("\n");
        if (out.isError) throw new ReadError(`import stopped after ${created} of ${specs.length} nodes${rootId ? ` (partial frame ${rootId})` : ""}: ${t.slice(0, 400)}`);
        rootId ??= /ROOT (\S+)/.exec(t)?.[1];
        if (/CLEAN 1/.test(t)) continue;
        const done = /DONE (\d+)/.exec(t);
        if (done) created = Number(done[1]);
      }
      return design.wrap(target, [
        `Imported ${created} nodes into a new frame "${frameName}" (${rootId}) at x ${screen.x}, ${Math.round(vw)}×${Math.round(vh)}.`,
        `${specs.filter((s) => s.props.type === "text").length} texts, ${specs.filter((s) => s.props.fill?.type === "image").length} image crops, ${specs.filter((s) => typeof s.props.fill === "string" && s.props.fill.startsWith("$")).length} fills on tokens${axis ? `, drawn in ${axis} ${theme}` : ""}.`,
        ...(snapshot.truncated ? ["The page has more elements than a capture keeps (6,000): the import is partial; import a narrower state or screen."] : []),
        "Positions are absolute (layout none): turn sections into auto layout where the design should flow, name the layers, and replace crops with icons or components where they exist. lint the frame to see what is left.",
      ]);
    },
  );

  tool(
    "sync_status",
    "Where design and code stand: every screen × width × theme of the document with its route (from .pen-multi.json routes), its last verify verdict and age, and whether the design changed since (stale). Lists what to verify next.",
    { filePath: optionalFilePath, maxLines: z.number().int().min(10).max(2000).optional().describe("Rows listed (default 200).") },
    async ({ filePath: f, maxLines = 200 }) => {
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
      const rows = [];
      for (const row of analysis.matrix.rows) {
        for (const [w, cells] of Object.entries(row.cells)) {
          for (const c of cells) {
            const r = reports.get(c.id);
            const routeFor = [c.name, row.screen, row.code].map((k) => conv.routes?.[k]).find(Boolean);
            // Open in the app, the document may have unsaved edits: freshness is unknown there.
            const stale = r && (!current || !r.pen?.sha1 ? null : r.pen.sha1 !== current);
            const tag = stale === null && r ? " (freshness unknown)" : stale ? " (stale)" : "";
            rows.push({ c, row, w, r, route: routeFor, stale, state: !r ? "never" : `${r.summary.verdict === "match" ? "match" : "differs"}${tag}` });
          }
        }
      }
      const count = (s) => rows.filter((x) => x.state === s).length;
      const lines = [
        `# sync status: ${rows.length} screen frames`,
        `match ${rows.filter((x) => x.state.startsWith("match")).length} · differs ${rows.filter((x) => x.state.startsWith("differs")).length} · stale ${rows.filter((x) => x.stale).length} · never verified ${count("never")} · with a route ${rows.filter((x) => x.route).length}${target.mode === "app" ? " · open in the app: save it for stale detection" : ""}`,
        "",
        "screen | state | width | theme | route | last verify",
      ];
      for (const x of rows.slice(0, maxLines)) {
        lines.push(`${x.row.screen}${x.row.state ? ` — ${x.row.state}` : ""} | ${x.state} | ${x.w} | ${x.c.theme ?? "–"} | ${x.route ?? "–"} | ${x.r ? `${x.r.summary.high} high, ${x.r.summary.medium} medium, ${ago(x.r.generatedAt)}` : "–"}`);
      }
      if (rows.length > maxLines) lines.push(`… ${rows.length - maxLines} more rows.`);
      const next = rows.filter((x) => x.route && (x.state === "never" || x.stale || x.state === "differs")).slice(0, 8);
      if (next.length) {
        lines.push("", "## Verify next");
        for (const x of next) lines.push(`- verify({ target: ${JSON.stringify(x.c.id)}, source: { kind: "web" } })  // ${x.c.name}: ${x.state}`);
      }
      if (!Object.keys(conv.routes ?? {}).length) lines.push("", 'No routes: add { "baseUrl": "http://localhost:5173", "routes": { "<screen>": "/path" } } to .pen-multi.json next to the .pen so verify can find each screen\'s page.');
      return design.wrap(target, lines);
    },
  );
}
