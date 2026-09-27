// Native adapters for apps without pen-probe: Android via `adb uiautomator dump`, iOS simulators via
// `maestro hierarchy`. Boxes, text and ids come from the view hierarchy; colors are sampled from
// the screenshot inside each element's box.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { readPngBuffer, sampleColors, writePng } from "../image.js";

const bin = {
  adb: () => process.env.PEN_MULTI_ADB ?? "adb",
  xcrun: () => process.env.PEN_MULTI_XCRUN ?? "xcrun",
  maestro: () => process.env.PEN_MULTI_MAESTRO ?? "maestro",
};

export function run(cmd, args, { binary = false, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: binary ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) {
        const why = err.code === "ENOENT" ? `${cmd} is not installed or not on PATH` : `${String(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`;
        return reject(new Error(`${cmd} ${args.join(" ")} failed: ${why}`));
      }
      resolve(stdout);
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseBounds = (s) => {
  const m = /\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]/.exec(s ?? "");
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
};
const decode = (s) =>
  String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
// Icon-font glyphs (Unicode private use areas) are icons, not text.
const PUA = /^[\uE000-\uF8FF\u{F0000}-\u{10FFFD}\s]+$/u;
const textOf = (t) => (t && !PUA.test(t) ? t.replace(/[\uE000-\uF8FF\u{F0000}-\u{10FFFD}]/gu, "").trim() || undefined : undefined);
const pen = (...vals) => vals.find((v) => v && /(^|:id\/)pen:/.test(v));

/** Parses `uiautomator dump` XML into elements in pixels (nesting kept as `parent`). */
export function parseUiautomator(xml) {
  const elements = [];
  const stack = [];
  const re = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  for (let m; (m = re.exec(xml)); ) {
    if (m[0] === "</node>") {
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const box = parseBounds(attrs.bounds);
    const el = {
      i: elements.length,
      parent: stack.length ? stack.at(-1) : undefined,
      tag: (attrs.class ?? "").split(".").pop(),
      selector: attrs["resource-id"] || attrs["content-desc"] || undefined,
      marker: pen(attrs["resource-id"], attrs["content-desc"]),
      text: textOf(attrs.text),
      box,
    };
    if (box && box.w > 0 && box.h > 0) elements.push(el);
    else el.i = -1;
    if (!m[2]) stack.push(el.i >= 0 ? el.i : stack.at(-1));
  }
  return elements;
}

/** Parses `maestro hierarchy` JSON (logs before it are skipped) into elements in points. */
export function parseMaestro(out) {
  const text = String(out);
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`maestro hierarchy printed no JSON: ${text.slice(0, 200)}`);
  const tree = JSON.parse(text.slice(start));
  const elements = [];
  const walk = (node, parent) => {
    const a = node.attributes ?? {};
    const box = parseBounds(a.bounds);
    let me = parent;
    if (box && box.w > 0 && box.h > 0) {
      me = elements.length;
      elements.push({
        i: me,
        parent,
        tag: a.class || a.elementType || undefined,
        selector: a["resource-id"] || a.accessibilityText || undefined,
        marker: pen(a["resource-id"], a.accessibilityText, a.identifier),
        text: textOf(a.text || a.hintText),
        box,
      });
    }
    for (const c of node.children ?? []) walk(c, me);
  };
  walk(tree, undefined);
  return elements;
}

/** Scales element boxes by 1/k and samples bg/fg colors from the screenshot at k pixels per unit. */
export function withSampledColors(elements, img, k) {
  return elements.map((el) => {
    const box = { x: el.box.x / k, y: el.box.y / k, w: el.box.w / k, h: el.box.h / k };
    const { bg, fg } = sampleColors(img, box, k);
    return { ...el, box, bg, fg: el.text ? fg : undefined };
  });
}

export const NATIVE_FIELDS = ["text", "bg", "fg"];

async function android({ device, deepLink, settleMs }, screenshotPath) {
  const dev = device ? ["-s", device] : [];
  if (deepLink) {
    await run(bin.adb(), [...dev, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", deepLink]);
    await sleep(settleMs);
  }
  // A fresh file per capture: a failed dump ("could not get idle state" while animating) must not
  // leave the previous screen's XML to be read as this one.
  const remote = `/sdcard/pen-ui-${process.pid}-${Date.now()}.xml`;
  let xml;
  try {
    const out = await run(bin.adb(), [...dev, "shell", "uiautomator", "dump", remote]);
    if (!/dumped to/i.test(out)) throw new Error(`uiautomator dump failed: ${out.trim().slice(0, 200) || "no output"} (is the screen still animating? retry with settleMs)`);
    xml = await run(bin.adb(), [...dev, "exec-out", "cat", remote]);
  } finally {
    await run(bin.adb(), [...dev, "shell", "rm", "-f", remote]).catch(() => {});
  }
  if (!/<hierarchy/.test(xml)) throw new Error(`uiautomator returned no hierarchy: ${xml.slice(0, 200)}`);
  const png = await run(bin.adb(), [...dev, "exec-out", "screencap", "-p"], { binary: true });
  const densityOut = await run(bin.adb(), [...dev, "shell", "wm", "density"]);
  const densities = [...densityOut.matchAll(/density:\s*(\d+)/gi)].map((m) => Number(m[1]));
  const density = densities.at(-1) ?? 160; // an override, when present, is printed last
  const k = density / 160;
  const img = readPngBuffer(png);
  writePng(screenshotPath, img);
  return { img, k, elements: parseUiautomator(xml), device: device ?? "default" };
}

async function ios({ device, deepLink, settleMs }, screenshotPath) {
  const target = device ?? "booted";
  if (deepLink) {
    await run(bin.xcrun(), ["simctl", "openurl", target, deepLink]);
    await sleep(settleMs);
  }
  await run(bin.xcrun(), ["simctl", "io", target, "screenshot", "--type=png", screenshotPath]);
  const out = await run(bin.maestro(), [...(device ? ["--device", device] : []), "hierarchy"], { timeout: 120_000 });
  const elements = parseMaestro(out);
  const img = readPngBuffer(fs.readFileSync(screenshotPath));
  const rootW = Math.max(...elements.filter((e) => e.parent === undefined).map((e) => e.box.x + e.box.w), 1);
  return { img, k: img.width / rootW, elements, device: target };
}

/** Captures the current screen of an emulator / simulator / device. */
export async function captureNative({ platform, device, deepLink, settleMs = 2000, screenshotPath }) {
  if (platform !== "android" && platform !== "ios") throw new Error(`source.platform must be "android" or "ios", not ${platform}`);
  const got = await (platform === "android" ? android : ios)({ device, deepLink, settleMs }, screenshotPath);
  const elements = withSampledColors(got.elements, got.img, got.k);
  return {
    snapshot: {
      version: 1,
      platform,
      source: platform === "android" ? "uiautomator" : "maestro",
      device: got.device,
      capturedAt: new Date().toISOString(),
      viewport: { w: got.img.width / got.k, h: got.img.height / got.k, scale: got.k },
      screenshot: screenshotPath,
      fields: NATIVE_FIELDS,
      elements,
    },
  };
}
