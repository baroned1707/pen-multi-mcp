// capture, verify and contact_sheet: compare a design screen with the running UI on any platform.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildModel } from "../design/model.js";
import { ReadError, readSubtree } from "../design/read.js";
import { captureNative } from "./adapters/native.js";
import { captureProbe } from "./adapters/probe.js";
import { captureWeb } from "./adapters/web.js";
import { designNodes } from "./design.js";
import { pngBuffer, readPng, resize, writePng } from "./image.js";
import { verifyScreen } from "./pipeline.js";
import { contactSheet, renderReport, sheetRow } from "./report.js";

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
  src.kind === "web" ? `web ${src.url}` : src.kind === "image" ? `image ${src.path}` : `${src.kind} ${src.platform}${src.device ? ` ${src.device}` : ""}${src.deepLink ? ` ${src.deepLink}` : ""}`;

export function registerVerifyTools({ tool, z, route, design, withMachineLock, optionalFilePath, ok }) {
  const source = z
    .object({
      kind: z.enum(["web", "probe", "native", "image"]).describe("web: a URL in headless Chromium; probe: a React Native/Expo dev build running <PenProbe>; native: any Android/iOS app via uiautomator/maestro; image: a screenshot file."),
      url: z.string().optional().describe("web: the page to load (the agent starts the dev server)."),
      steps: z.array(z.record(z.string(), z.any())).optional().describe('web: actions before capturing, e.g. [{ "click": "text=Login" }, { "fill": ["#email", "a@b.c"] }, { "waitFor": ".list" }, { "wait": 500 }, { "press": "Enter" }, { "eval": "..." }].'),
      fullPage: z.boolean().optional().describe("web: capture the whole scrolling page (default true)."),
      platform: z.enum(["ios", "android"]).optional().describe("probe/native: the device platform."),
      device: z.string().optional().describe("probe/native: simulator UDID / adb serial (default: the booted one)."),
      deepLink: z.string().optional().describe("probe/native: open this URL in the app first."),
      settleMs: z.number().int().min(0).max(60_000).optional().describe("probe/native: wait after the deep link (default 2000)."),
      timeoutMs: z.number().int().min(1000).max(120_000).optional().describe("probe: how long to wait for the app's snapshot (default 20000)."),
      path: z.string().optional().describe("image: PNG screenshot path."),
      width: z.number().positive().optional().describe("image: the screenshot's logical width (e.g. 390 for a 1170 px iPhone shot)."),
    })
    .describe("Where the implemented UI comes from.");

  /** Captures a source into design-verify/captures/<name>.{json,png}. */
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
      ({ snapshot } = await captureWeb({ url: src.url, steps: src.steps, fullPage: src.fullPage !== false, width, height, colorScheme, screenshotPath }));
    } else if (src.kind === "probe") {
      ({ snapshot } = await withMachineLock("pen-probe", () => captureProbe({ ...src, screenshotPath })));
    } else if (src.kind === "native") {
      // One capture per device at a time: dumps and screenshots of two agents must not interleave.
      ({ snapshot } = await withMachineLock(`device:${src.platform}:${src.device ?? "default"}`, () => captureNative({ ...src, screenshotPath })));
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
    "Capture the implemented UI as data: every visible element's box, text, colors, typography and pen marker, plus a screenshot. Sources: a web URL (headless, no window), a React Native/Expo dev build with <PenProbe>, any Android/iOS app via uiautomator/maestro, or a screenshot file. verify captures by itself; use capture to keep a snapshot or to look at what the UI renders.",
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
    `Check an implementation against its design and get the differences as text: design nodes missing from the UI, UI text that is not in the design (old UI left behind), section order, and size, position, color, typography, radius and border differences beyond tolerance, plus pixel regions named after the design nodes there. Works for web (URL, headless), React Native/Expo (pen-probe), native Android/iOS (uiautomator/maestro) and plain screenshots. A port is done when the verdict is MATCH for every implemented screen × width × theme. Writes the full JSON report and a contact sheet PNG to ${OUT_DIR}/.`,
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
    },
    async ({ filePath: f, target: wanted, width, theme, source: src, snapshot: snapPath, tolerance, maxLines = 120 }) => {
      if (!src && !snapPath) throw new ReadError("Pass source (to capture now) or snapshot (a capture file).");
      const target = await route(f);
      const run = design.reader(target);
      const { id, theme: frameTheme } = await pickFrame(target, wanted, { width, theme });
      const model = buildModel(await readSubtree(run, id));
      const rootTheme = model.root.theme && typeof model.root.theme === "object" ? Object.values(model.root.theme)[0] : undefined;
      const d = designNodes(model);
      // The .pen's hash keeps forks of the same screen (verified by two agents at once) apart.
      const fileTag = createHash("sha1").update(target.file).digest("hex").slice(0, 6);
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
      const result = verifyScreen({ design: d, snapshot, designImg, uiImg, tolerance });

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
      const penHash = target.mode === "app" || !fs.existsSync(target.file) ? null : createHash("sha1").update(fs.readFileSync(target.file)).digest("hex");
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
            files,
            meta,
          },
          null,
          1,
        ),
      );
      return design.wrap(target, renderReport({ meta, ...result, files, maxLines }));
    },
  );

  tool(
    "contact_sheet",
    "One image comparing screens side by side, a row per verify report: the design, the implemented UI, and the UI with each finding's numbered box (missing nodes are boxed on the design). For people and for a quick look; the verify text report is the reliable signal.",
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
}
