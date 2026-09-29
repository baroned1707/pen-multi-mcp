// capture, verify and contact_sheet: compare a design screen with the running UI on any platform.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildModel } from "../design/model.js";
import { ReadError, readSubtree } from "../design/read.js";
import { captureNative } from "./adapters/native.js";
import { captureProbe } from "./adapters/probe.js";
import { captureWeb } from "./adapters/web.js";
import { SourceError, captureCommand, captureFile } from "./adapters/command.js";
import { designNodes } from "./design.js";
import { pngBuffer, readPng, resize, writePng } from "./image.js";
import { verifyScreen } from "./pipeline.js";
import { contactSheet, findingCrops, renderReport, sheetRow } from "./report.js";
import { pointFindingsAtCode } from "./code.js";
import { USAGE_SNIPPET, designEdits, editLines, propertyNumbers } from "./reverse.js";
import { nextStep } from "../guide.js";
import { annotate } from "../calllog.js";
import { buildRecord, diffText, factsDiff, frameDiff, readRecord, recordPath, syncState, writeRecord } from "../sync/index.js";
import { primaryFill } from "../design/inspect.js";

/** A frame's own background as a color string, when it is one. */
const frameFill = (root) => {
  const p = primaryFill(root.fill, root.resolved?.fill);
  return p?.kind === "color" ? p.resolved ?? p.raw : undefined;
};
export { frameFill };
import { projectMapping } from "../mapping/index.js";

const OUT_DIR = "design-verify";
const DARK = /\b(dark|night|tối|toi|đêm)\b/i;
const LIGHT = /\b(light|day|sáng|sang|ngày)\b/i;
export const colorSchemeOf = (theme) => (!theme ? undefined : DARK.test(theme) ? "dark" : LIGHT.test(theme) ? "light" : undefined);
export const slug = (s) =>
  String(s ?? "screen")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80) || "screen";

/** A snapshot written by capture: refuses to read or overwrite anything else. */
function isSnapshotFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && j.version === 1 && Array.isArray(j.elements) && j.viewport && typeof j.viewport.w === "number";
  } catch {
    return false;
  }
}

const describeSource = (src) =>
  (src.kind === "web" ? `web ${src.url}` : src.kind === "image" ? `image ${src.path}` : `${src.kind} ${src.platform}${src.device ? ` ${src.device}` : ""}${src.deepLink ? ` ${src.deepLink}` : ""}`) +
  (src.state ? ` (state "${src.state}" from .pen-multi.json${src.kind === "web" ? "" : ", its deepLink only"})` : "") +
  (src.mocks?.length ? ` with ${src.mocks.length} mock${src.mocks.length > 1 ? "s" : ""}` : "");

export function registerVerifyTools({ tool, z, route, design, withMachineLock, optionalFilePath, ok, conventions, saver, hooks = {} }) {
  const repeats = new Map(); // file|frame -> { sig, count }: the same findings verify after verify
  // The page a screen is served at: .pen-multi.json { baseUrl, routes: { "<screen name, code or frame name>": "/path" } }.
  /**
   * .pen-multi.json `states`: how to show a frame's state ({ route?, steps?, mocks?, deepLink? }),
   * keyed by frame name, "Screen — state", screen or code. Its steps run before the call's; its
   * mocks apply unless the call mocks the same url; its route/deepLink fill in what is missing.
   */
  function stateFor(target, wanted, frame) {
    const states = conventions(target.file).states ?? {};
    const row = frame?.row;
    // A state frame ("Home — empty") never falls back to its screen's entry: that is another state.
    const keys = row?.state
      ? [frame?.name, `${row.screen} — ${row.state}`, wanted !== row.screen && wanted !== row.code ? wanted : null]
      : [frame?.name, wanted, row?.code, row?.screen];
    const key = keys.filter(Boolean).find((k) => states[k]);
    return key ? { key, ...states[key] } : null;
  }
  function withState(target, wanted, frame, src) {
    const st = stateFor(target, wanted, frame);
    if (!st) return src;
    const out = { ...src };
    if (out.kind === "web") {
      if (!out.url && st.route) out.url = /^[a-z]+:/i.test(st.route) ? st.route : routeJoin(conventions(target.file).baseUrl, st.route);
      out.steps = [...(st.steps ?? []), ...(src.steps ?? [])];
      // The call's mocks win over the state's for the same url and method.
      const key = (m) => `${m.method?.toUpperCase() ?? "*"} ${m.url}`;
      const own = new Set((src.mocks ?? []).map(key));
      out.mocks = [...(src.mocks ?? []), ...(st.mocks ?? []).filter((m) => !own.has(key(m)) && !own.has(`* ${m.url}`))];
    } else if (!out.deepLink && st.deepLink) out.deepLink = st.deepLink;
    out.state = st.key;
    return out;
  }
  const routeJoin = (base, route) => {
    if (!base) throw new ReadError(`.pen-multi.json state route "${route}" needs a baseUrl.`);
    return `${base.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
  };

  function routeUrl(target, wanted, frame) {
    const conv = conventions(target.file);
    const keys = [...new Set([frame?.name, wanted, frame?.row?.screen, frame?.row?.code].filter(Boolean))];
    const hit = keys.map((k) => conv.routes?.[k]).find(Boolean);
    if (!hit) throw new ReadError(`source.url is missing and .pen-multi.json has no route for ${keys.map((k) => `"${k}"`).join(" / ")}; pass url, or add { "baseUrl": "http://localhost:5173", "routes": { "${frame?.row?.screen ?? wanted}": "/path" } } next to the .pen.`);
    if (/^[a-z]+:/i.test(hit)) return hit;
    if (!conv.baseUrl) throw new ReadError(`.pen-multi.json routes "${hit}" but has no baseUrl.`);
    // Joined as paths, so a baseUrl with a path ("http://host/app") keeps it for "/orders".
    return `${conv.baseUrl.replace(/\/+$/, "")}/${hit.replace(/^\/+/, "")}`;
  }
  const source = z
    .object({
      kind: z.enum(["web", "probe", "native", "image", "file", "command"]).describe("web: a URL in headless Chromium; probe: a React Native/Expo dev build running <PenProbe>; native: any Android/iOS app via uiautomator/maestro; image: a screenshot file; file: a snapshot JSON written by any tool (schema: resource pen-multi://snapshot-schema); command: a trusted project command that writes one (any platform: Flutter, desktop, …)."),
      url: z.string().optional().describe("web: the page to load (the agent starts the dev server). verify can omit it when .pen-multi.json maps the screen to a route."),
      steps: z.array(z.record(z.string(), z.any())).optional().describe('web: actions before capturing, e.g. [{ "click": "text=Login" }, { "fill": ["#email", "a@b.c"] }, { "waitFor": ".list" }, { "wait": 500 }, { "press": "Enter" }, { "eval": "..." }].'),
      fullPage: z.boolean().optional().describe("web: capture the whole scrolling page (default true)."),
      mocks: z
        .array(
          z.object({
            url: z.string().describe('Glob ("**/api/today*") or "/regex/flags".'),
            method: z.string().optional(),
            status: z.number().int().optional(),
            json: z.any().optional().describe("Response body as JSON."),
            body: z.string().optional(),
            file: z.string().optional().describe("Response body from a file (relative to the working directory)."),
            headers: z.record(z.string(), z.string()).optional(),
            delayMs: z.number().int().min(0).max(60000).optional().describe("Delay the answer (loading states)."),
          }),
        )
        .optional()
        .describe("web: answer matching requests with fixtures, to put the page into a state (empty, error, loading) without a backend."),
      platform: z.enum(["ios", "android"]).optional().describe("probe/native: the device platform."),
      device: z.string().optional().describe("probe/native: simulator UDID / adb serial (default: the booted one)."),
      deepLink: z.string().optional().describe("probe/native: open this URL in the app first."),
      settleMs: z.number().int().min(0).max(60_000).optional().describe("probe/native: wait after the deep link (default 2000)."),
      timeoutMs: z.number().int().min(1000).max(120_000).optional().describe("probe: how long to wait for the app's snapshot (default 20000)."),
      path: z.string().optional().describe("image: PNG screenshot path; file: snapshot JSON path."),
      run: z.string().optional().describe('command: the shell command. It gets PEN_SNAPSHOT_OUT, PEN_SCREENSHOT_OUT, PEN_WIDTH, PEN_HEIGHT, PEN_THEME, PEN_TARGET, PEN_STATE and writes the snapshot there. Runs only if the user trusted it for this project (the error says how).'),
      cwd: z.string().optional().describe("command: folder to run it in (default: the working directory)."),
      width: z.number().positive().optional().describe("image: the screenshot's logical width (e.g. 390 for a 1170 px iPhone shot)."),
    })
    .describe("Where the implemented UI comes from.");

  /** Captures a source into design-verify/captures/<name>.{json,png}. */
  // Source errors (a bad snapshot, an untrusted command) are the agent's to fix, not crashes.
  const wrapSource = (fn) => {
    try {
      return fn();
    } catch (err) {
      throw err instanceof SourceError ? new ReadError(err.message) : err;
    }
  };
  const wrapSourceAsync = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      throw err instanceof SourceError ? new ReadError(err.message) : err;
    }
  };

  async function capture(src, { width, height, colorScheme, name, savePath }) {
    const base = savePath ? path.resolve(process.cwd(), savePath).replace(/\.(json|png)$/i, "") : path.join(process.cwd(), OUT_DIR, "captures", name);
    // At a path the caller chose, only a previous capture may be replaced, never an unrelated JSON
    // or image. design-verify/captures/ belongs to this tool (a failed capture may leave a lone PNG).
    if (savePath) {
      const own = fs.existsSync(`${base}.json`) && isSnapshotFile(`${base}.json`);
      for (const f of [`${base}.json`, `${base}.png`]) {
        if (fs.existsSync(f) && !own) throw new ReadError(`${f} exists and is not a capture; refusing to overwrite it. Choose another savePath.`);
      }
    }
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const screenshotPath = `${base}.png`;
    let snapshot;
    if (src.kind === "web") {
      if (!src.url) throw new ReadError("source.url is required for kind web");
      ({ snapshot } = await captureWeb({ url: src.url, steps: src.steps, mocks: src.mocks ?? [], fullPage: src.fullPage !== false, width, height, colorScheme, screenshotPath }));
    } else if (src.kind === "probe") {
      ({ snapshot } = await withMachineLock("pen-probe", () => captureProbe({ ...src, screenshotPath })));
    } else if (src.kind === "native") {
      // One capture per device at a time: dumps and screenshots of two agents must not interleave.
      ({ snapshot } = await withMachineLock(`device:${src.platform}:${src.device ?? "default"}`, () => captureNative({ ...src, screenshotPath })));
    } else if (src.kind === "file") {
      if (!src.path) throw new ReadError("source.path is required for kind file");
      snapshot = wrapSource(() => captureFile(src)).snapshot;
      if (snapshot.screenshot && fs.existsSync(snapshot.screenshot)) fs.copyFileSync(snapshot.screenshot, screenshotPath), (snapshot.screenshot = screenshotPath);
    } else if (src.kind === "command") {
      if (!src.run) throw new ReadError("source.run is required for kind command");
      const home = process.env.PEN_MULTI_HOME ?? path.join(os.homedir(), ".pen-multi");
      snapshot = (await wrapSourceAsync(() => captureCommand(src, { home, width, height, theme: colorScheme, target: name, state: src.state, out: `${base}-command` }))).snapshot;
      if (snapshot.screenshot && fs.existsSync(snapshot.screenshot) && snapshot.screenshot !== screenshotPath) fs.copyFileSync(snapshot.screenshot, screenshotPath), (snapshot.screenshot = screenshotPath);
    } else {
      if (!src.path) throw new ReadError("source.path is required for kind image");
      const file = path.resolve(process.cwd(), src.path);
      const img = readPng(file);
      const w = src.width ?? width ?? img.width;
      writePng(screenshotPath, img);
      snapshot = { version: 1, platform: "image", source: "image", capturedAt: new Date().toISOString(), viewport: { w, h: (img.height * w) / img.width, scale: img.width / w }, screenshot: screenshotPath, fields: [], elements: [] };
    }
    snapshot.request = src;
    fs.writeFileSync(`${base}.json`, JSON.stringify(snapshot, null, 1));
    return { snapshot, snapshotPath: `${base}.json` };
  }

  tool(
    "capture",
    "Use when you need what the running UI renders (elements and screenshot) without comparing it. Not for checking against the design (verify). Capture the implemented UI as data: every visible element's box, text, colors, typography and pen marker, plus a screenshot. Sources: a web URL (headless, no window), a React Native/Expo dev build with <PenProbe>, any Android/iOS app via uiautomator/maestro, or a screenshot file. verify captures by itself; use capture to keep a snapshot or to look at what the UI renders.",
    {
      source,
      width: z.number().positive().optional().describe("web: viewport width (default 390)."),
      height: z.number().positive().optional().describe("web: viewport height (default 844)."),
      colorScheme: z.enum(["light", "dark"]).optional().describe("web: prefers-color-scheme."),
      savePath: z.string().optional().describe("Where to write <name>.json and <name>.png (default design-verify/captures/)."),
    },
    async ({ source: src, width = 390, height = 844, colorScheme, savePath }) => {
      const { snapshot, snapshotPath } = await capture(src, { width, height, colorScheme, name: slug(`${src.kind}-${src.url ?? src.path ?? src.platform}`), savePath });
      const markers = snapshot.elements.filter((e) => e.marker).length;
      const texts = snapshot.elements.filter((e) => e.text).length;
      return ok(
        [
          `Captured ${describeSource(src)}: ${snapshot.elements.length} elements (${texts} with text, ${markers} with pen markers), viewport ${Math.round(snapshot.viewport.w)}×${Math.round(snapshot.viewport.h)}.`,
          `Snapshot: ${snapshotPath}`,
          `Screenshot: ${snapshot.screenshot}`,
          ...(snapshot.pageErrors ?? []).map((e) => `Page error: ${e}`),
        ].join("\n"),
      );
    },
  );

  /** The frame to verify: the target, or its sibling cell for another width/theme. */
  async function pickFrame(target, wanted, { width, theme }) {
    let resolved = await design.resolveTarget(target, wanted);
    // An id resolves without the document analysis unless it is cached; the row (width/theme
    // variants) and the frame's theme need it.
    if (!resolved.frame) resolved = await design.resolveTarget(target, wanted, { refreshed: true });
    let { id, frame } = resolved;
    if ((width || theme) && !frame?.row) throw new ReadError(`${wanted} is not a screen frame, so width/theme cannot pick a variant; pass the screen's name or frame id, or leave width/theme out.`);
    if (frame?.row && (width || theme)) {
      const cells = Object.entries(frame.row.cells).flatMap(([w, cs]) => cs.map((c) => ({ ...c, width: Number(w) || w })));
      const fits = cells.filter((c) => (!width || String(c.width) === String(width)) && (!theme || String(c.theme ?? "").toLowerCase() === String(theme).toLowerCase()));
      if (!fits.length) {
        throw new ReadError(
          `${frame.row.screen} has no frame for${width ? ` width ${width}` : ""}${theme ? ` theme ${theme}` : ""}. Variants: ${cells.map((c) => `${c.name} (${c.width}${c.theme ? `, ${c.theme}` : ""}) → ${c.id}`).join("; ")}`,
        );
      }
      const best = fits.find((c) => c.id === id) ?? fits[0];
      id = best.id;
      frame = { ...best, row: frame.row };
    }
    return { id, frame, theme: theme ?? frame?.theme };
  }

  /** Renders the design frame to PNG next to the reports (headless or in the app). */
  async function renderDesign(run, id, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const res = await run(`Export(${JSON.stringify([id])}, "png", ${JSON.stringify(dir)})`);
    if (res.error) throw new ReadError(`could not render the design frame: ${res.error}`);
    const m = /Exported (.+\.png)/.exec(res.text ?? "");
    const file = m ? m[1].trim() : path.join(dir, `${id}.png`);
    if (!fs.existsSync(file)) throw new ReadError(`the design render was not written (${file})`);
    return file;
  }

  tool(
    "verify",
    `Use when a screen is implemented (or changed) in code, to know whether it matches the design — and with direction "code-to-design" when the design should follow the code. Not for looking at a page (capture). Check an implementation against its design and get the differences as text: design nodes missing from the UI, UI text that is not in the design (old UI left behind), section order, and size, position, color, typography, radius and border differences beyond tolerance, plus pixel regions named after the design nodes there. Works for web (URL, headless), React Native/Expo (pen-probe), native Android/iOS (uiautomator/maestro) and plain screenshots. A port is done when the verdict is MATCH for every implemented screen × width × theme. Writes the full JSON report and a contact sheet PNG to ${OUT_DIR}/.`,
    {
      filePath: optionalFilePath,
      target: z.string().describe("Screen name, code or node id, as for inspect."),
      width: z.number().positive().optional().describe("Pick the screen's frame for this width (e.g. 390, 1280)."),
      theme: z.string().optional().describe('Pick the screen\'s frame for this theme (e.g. "dark"); web captures use it as prefers-color-scheme.'),
      source: source.optional(),
      snapshot: z.string().optional().describe("Instead of source: a snapshot JSON written by capture."),
      tolerance: z
        .object({ position: z.number(), size: z.number(), sizeRatio: z.number(), color: z.number(), fontSize: z.number(), fontWeight: z.number(), lineHeight: z.number(), radius: z.number() })
        .partial()
        .optional()
        .describe("Overrides: position/size px (4), sizeRatio (0.05), color ΔE (10), fontSize px (1), fontWeight (100), lineHeight px (2), radius px (2)."),
      maxLines: z.number().int().min(10).max(2000).optional().describe("Findings listed inline (default 120); the JSON has all."),
      direction: z.enum(["design-to-code", "code-to-design"]).optional().describe('"design-to-code" (default): the code should follow the design. "code-to-design": the design should follow the code — each finding with a clear cause gets a proposed execute operation (not applied).'),
      crops: z.number().int().min(0).max(10).optional().describe("Close-ups (design | app) of the worst findings attached as images (default 3; 0 for none)."),
    },
    async ({ filePath: f, target: wanted, width, theme, source: src, snapshot: snapPath, tolerance, maxLines = 120, crops = 3, direction = "design-to-code" }) => {
      if (!src && !snapPath) throw new ReadError("Pass source (to capture now) or snapshot (a capture file).");

      const target = await route(f);
      const run = design.reader(target);
      const { id, frame: picked, theme: frameTheme } = await pickFrame(target, wanted, { width, theme });
      if (src) src = withState(target, wanted, picked, src);
      if (src?.kind === "web" && !src.url) src = { ...src, url: routeUrl(target, wanted, picked) };
      const model = buildModel(await readSubtree(run, id));
      const rootTheme = model.root.theme && typeof model.root.theme === "object" ? Object.values(model.root.theme)[0] : undefined;
      const d = designNodes(model);
      // The .pen's hash keeps forks of the same screen (verified by two agents at once) apart.
      // With the id: two frames with the same name (e.g. one per width) keep their own reports.
      const fileTag = createHash("sha1").update(`${target.file}\n${id}`).digest("hex").slice(0, 6);
      const name = slug([model.root.name ?? id, width, theme, fileTag].filter(Boolean).join("-"));
      const outBase = path.join(process.cwd(), OUT_DIR, name);
      // Per .pen file: forks share node ids, and two agents may verify both at once.
      const renderDir = path.join(process.cwd(), OUT_DIR, ".render", createHash("sha1").update(target.file).digest("hex").slice(0, 10));
      const designPng = await renderDesign(run, id, renderDir);

      let snapshot, snapshotPath;
      if (snapPath) {
        snapshotPath = path.resolve(process.cwd(), snapPath);
        if (!isSnapshotFile(snapshotPath)) throw new ReadError(`${snapshotPath} is not a capture snapshot (written by capture or verify).`);
        snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      } else {
        const viewportH = Math.min(d.frame.h, 1080);
        ({ snapshot, snapshotPath } = await capture(src, { width: d.frame.w, height: viewportH, colorScheme: colorSchemeOf(frameTheme ?? rootTheme), name }));
      }
      const designImg = readPng(designPng);
      const uiImg = snapshot.screenshot && fs.existsSync(snapshot.screenshot) ? readPng(snapshot.screenshot) : null;
      const { pairs, ...result } = verifyScreen({ design: d, snapshot, designImg, uiImg, tolerance });
      // Point findings at the code (markers) and name the design tokens they concern.
      const mapping = projectMapping({ penFile: target.file, conv: conventions(target.file), variables: model.variables, themes: model.themes });
      const where = pointFindingsAtCode(result.findings, { model, d, snapshot, mapping });
      result.hints = [...(result.hints ?? []), ...mapping.notes];
      if (where.unlocated && !mapping.index.notGit && !mapping.index.truncated) result.hints.push(`${where.unlocated} finding(s) have no code location (${where.reason}). Mark elements with data-pen="<node id or address>" (web) or testID/Key/accessibility id "pen:<…>" to get file:line.`);

      const sheetPath = uiImg ? `${outBase}.png` : null;
      if (uiImg) writePng(sheetPath, contactSheet([sheetRow({ designImg, uiImg, frame: d.frame, findings: result.findings, uiWidth: snapshot.viewport?.w })]));
      const files = { report: `${outBase}.json`, contactSheet: sheetPath, snapshot: snapshotPath, designRender: designPng };
      const meta = {
        screen: model.root.name ?? id,
        frameId: id,
        sourceLabel: snapshot.request ? describeSource(snapshot.request) : snapshot.url ?? snapshot.platform,
        viewport: `${Math.round(snapshot.viewport.w)}×${Math.round(snapshot.viewport.h)}${result.scale !== 1 ? ` (×${Math.round(result.scale * 1000) / 1000} to design units)` : ""}`,
        theme: frameTheme,
        width: d.frame.w,
      };
      await saver?.flush(target.file).catch(() => {}); // hash the design as saved, not mid-save
      const penHash = target.mode === "app" || !fs.existsSync(target.file) ? null : createHash("sha1").update(fs.readFileSync(target.file)).digest("hex");
      let previousHash = null;
      try {
        previousHash = JSON.parse(fs.readFileSync(files.report, "utf8")).pen?.sha1 ?? null;
      } catch {}
      // Sync record: written on MATCH; on DIFFERS, what changed on each side since the last one.
      const frameInfo = { id, name: model.root.name ?? id, width: d.frame.w, theme: frameTheme ?? rootTheme ?? null, fill: frameFill(model.root) };
      const syncFile = recordPath(target.file, frameInfo);
      const prior = readRecord(syncFile);
      const current = buildRecord({ penFile: target.file, penSha: penHash, frame: frameInfo, design: d, pairs, fields: snapshot.fields ?? [], source: snapshot.request ?? null });
      let sync = null;
      if (result.summary.verdict === "match") {
        writeRecord(syncFile, current);
        sync = { recorded: path.relative(process.cwd(), syncFile) };
      } else if (prior) {
        const designDiff = factsDiff(prior.nodes, current.nodes, "design");
        const codeDiff = factsDiff(prior.nodes, current.nodes, "ui");
        const touched = (x) => [...x.added, ...x.removed, ...x.changed.map((c) => c.address)];
        const dz = touched(designDiff), cz = touched(codeDiff);
        // The frame's own fill counts as a design change, but tags no finding (every address is under the frame).
        const frameChange = frameDiff(prior.frame, current.frame);
        designDiff.changed.unshift(...frameChange);
        const hits = (list, a) => list.some((x) => a === x || a.startsWith(`${x}/`) || x.startsWith(`${a}/`));
        for (const f of result.findings) {
          if (!f.address) continue;
          const inD = hits(dz, f.address), inC = hits(cz, f.address);
          f.since = inD && inC ? "both" : inD ? "design" : inC ? "code" : undefined;
        }
        const overlap = dz.some((a) => hits(cz, a));
        sync = { state: syncState({ record: prior, designChanged: dz.length + frameChange.length > 0, codeChanged: cz.length > 0, overlap }), recordedAt: prior.verifiedAt, design: diffText(designDiff), code: diffText(codeDiff) };
      }
      fs.writeFileSync(
        files.report,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            pen: { path: target.file, sha1: penHash },
            target: { id, name: model.root.name, width: d.frame.w, height: d.frame.h, theme: frameTheme },
            source: snapshot.request ?? null,
            uiWidth: snapshot.viewport?.w,
            ...result,
            sync,
            files,
            meta,
          },
          null,
          1,
        ),
      );
      await hooks.onVerify?.(target.file, id, { summary: result.summary }, files.report);
      let reportLines = renderReport({ meta, ...result, files, maxLines });
      if (direction === "code-to-design") {
        const s = result.scale ?? 1;
        const elements = (snapshot.elements ?? []).map((e) => ({ ...e, box: e.box && { x: e.box.x * s, y: e.box.y * s, w: e.box.w * s, h: e.box.h * s } }));
        const usage = await run(USAGE_SNIPPET);
        const edits = designEdits(result.findings, { model, theme: frameTheme ?? rootTheme ?? null, elements, numbers: propertyNumbers(model.variables, usage.text) });
        reportLines = [...reportLines, ...editLines(edits, { designChanged: Boolean(previousHash && penHash && previousHash !== penHash) })];
      }
      // The same findings again and again: the fixes are not landing where verify looks.
      const sig = result.findings.filter((x) => x.severity !== "low").map((x) => `${x.kind}:${x.address ?? x.uiIndex}`).sort().join("|");
      const seen = repeats.get(`${target.file}|${id}`);
      const count = seen && seen.sig === sig && sig ? seen.count + 1 : 1;
      repeats.set(`${target.file}|${id}`, { sig, count });
      if (count >= 3 && result.summary.verdict !== "match") reportLines.push("", `Note: verify returned the same findings ${count} times in a row. Check that the page shows your change (route, state, dev server reloaded, the right file), or change approach.`);
      const others = picked?.row ? Object.values(picked.row.cells).flat().map((c) => c.id).filter((x) => x !== id) : [];
      if (sync?.recorded) reportLines.push("", `Recorded as the last match in ${sync.recorded} (commit it with the code, so every agent and machine knows where design and code stand).`);
      if (sync?.state) {
        reportLines.push("", `## Since the last match (${sync.recordedAt})`, `- Design: ${sync.design || "no change"}`, `- Code: ${sync.code || "no change"}`);
      }
      annotate({ verify: { verdict: result.summary.verdict, high: result.summary.high, medium: result.summary.medium, direction, frame: id, sync: sync?.state ?? (sync?.recorded ? "recorded" : undefined), kinds: [...new Set(result.findings.filter((x) => x.severity !== "low").map((x) => x.kind))] } });
      const syncNext = sync?.state && direction !== "code-to-design" && ["design-changed", "code-changed", "both-changed", "diverged"].includes(sync.state) ? sync.state : null;
      reportLines.push("", nextStep({ state: syncNext ?? (result.summary.verdict === "match" ? "match" : "differs"), id, direction, others }));
      const res = design.wrap(target, reportLines);
      if (uiImg && crops > 0) {
        for (const { finding, image } of findingCrops({ designImg, uiImg, frame: d.frame, findings: result.findings, uiWidth: snapshot.viewport?.w, n: crops })) {
          res.content.push({ type: "text", text: `Finding ${finding.n} [${finding.severity}] close-up — left: design, right: app.` }, { type: "image", data: pngBuffer(image).toString("base64"), mimeType: "image/png" });
        }
      }
      return res;
    },
  );

  tool(
    "contact_sheet",
    "Use when showing a person several verify results side by side. One image comparing screens side by side, a row per verify report: the design, the implemented UI, and the UI with each finding's numbered box (missing nodes are boxed on the design). For people and for a quick look; the verify text report is the reliable signal.",
    {
      reports: z.array(z.string()).min(1).max(40).describe("verify report JSON paths (design-verify/<screen>.json)."),
      savePath: z.string().optional().describe("PNG path (default design-verify/contact-sheet.png)."),
    },
    async ({ reports, savePath }) => {
      const rows = [];
      const lines = [];
      for (const p of reports) {
        const file = path.resolve(process.cwd(), p);
        const rep = JSON.parse(fs.readFileSync(file, "utf8"));
        const shot = rep.files?.snapshot && fs.existsSync(rep.files.snapshot) ? JSON.parse(fs.readFileSync(rep.files.snapshot, "utf8")).screenshot : null;
        if (!rep.files?.designRender || !fs.existsSync(rep.files.designRender) || !shot || !fs.existsSync(shot)) {
          lines.push(`- ${p}: skipped (its design render or screenshot is gone; re-run verify)`);
          continue;
        }
        const row = sheetRow({ designImg: readPng(rep.files.designRender), uiImg: readPng(shot), frame: { w: rep.target.width }, findings: rep.findings, uiWidth: rep.uiWidth });
        rows.push(row.width > 2400 ? resize(row, 2400) : row); // bounded before stacking up to 40 rows
        lines.push(`- row ${rows.length}: ${rep.meta?.screen} — ${rep.summary.verdict === "match" ? "MATCH" : `${rep.summary.high} high, ${rep.summary.medium} medium, ${rep.summary.low} low`}`);
      }
      if (!rows.length) throw new ReadError(`Nothing to draw:\n${lines.join("\n")}`);
      const out = path.resolve(process.cwd(), savePath ?? path.join(OUT_DIR, "contact-sheet.png"));
      if (!/\.png$/i.test(out)) throw new ReadError(`savePath must end with .png: ${savePath}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      writePng(out, contactSheet(rows));
      const preview = contactSheet(rows, 1600);
      const res = ok([`Contact sheet: ${out} (columns: design | UI | UI with numbered findings)`, ...lines].join("\n"));
      res.content.push({ type: "image", data: pngBuffer(preview).toString("base64"), mimeType: "image/png" });
      return res;
    },
  );
  return { capture, source, stateFor };
}
