// Icons in code → icon nodes in the design: each icon element of a capture is compared, as a
// shape, with the icons the document already uses (rendered once by the engine in a scratch file).
// Only a clear winner is taken; anything else stays a crop of the screenshot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crop, readPng, resize } from "../verify/image.js";

const SIZE = 24; // mask resolution
const at = (img, x, y) => (y * img.width + x) * 4;

/**
 * A shape mask: pixels far from the background (taken from the image's border) are ink; the ink's
 * bounding box is centered in a square and scaled to SIZE×SIZE. Returns { bits, ink } or null.
 */
export function maskOf(img) {
  const { width: w, height: h, data } = img;
  if (w < 4 || h < 4) return null;
  // Background: the average border color.
  let br = 0, bg = 0, bb = 0, n = 0;
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) (br += data[at(img, x, y)]), (bg += data[at(img, x, y) + 1]), (bb += data[at(img, x, y) + 2]), n++;
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) (br += data[at(img, x, y)]), (bg += data[at(img, x, y) + 1]), (bb += data[at(img, x, y) + 2]), n++;
  (br /= n), (bg /= n), (bb /= n);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const inkAt = (x, y) => {
    const i = at(img, x, y);
    return Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 90;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inkAt(x, y)) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  if (x1 < 0) return null;
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  // Ink as black on white in a square around its center, then scaled down.
  const sq = { width: side, height: side, data: new Uint8Array(side * side * 4).fill(255) };
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const sx = Math.floor(cx - side / 2 + x), sy = Math.floor(cy - side / 2 + y);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h && inkAt(sx, sy)) {
        const i = (y * side + x) * 4;
        sq.data[i] = sq.data[i + 1] = sq.data[i + 2] = 0;
      }
    }
  }
  const small = resize(sq, SIZE, SIZE);
  const bits = new Uint8Array(SIZE * SIZE);
  let ink = 0;
  for (let k = 0; k < bits.length; k++) if (small.data[k * 4] < 170) (bits[k] = 1), ink++;
  return { bits, ink };
}

/** Intersection over union of two masks. */
export function iou(a, b) {
  let inter = 0, union = 0;
  for (let k = 0; k < a.bits.length; k++) {
    if (a.bits[k] && b.bits[k]) inter++;
    if (a.bits[k] || b.bits[k]) union++;
  }
  return union ? inter / union : 0;
}

/** The best candidate for a mask when it is clearly the best: { key, score } or null. */
export function bestIcon(mask, candidates, { min = 0.55, margin = 0.08 } = {}) {
  const scored = candidates.map((c) => ({ key: c.key, score: iou(mask, c.mask) })).sort((x, y) => y.score - x.score);
  const [top, next] = scored;
  if (!top || top.score < min || (next && top.score - next.score < margin)) return null;
  return top;
}

/**
 * Masks of the document's icons, rendered by the engine in a scratch file (never the design):
 * `run(file, input)` runs an execute snippet in that file. Returns [{ key: "library:icon", mask }].
 */
export async function renderCandidates(icons, run) {
  if (!icons.length) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-icons-"));
  const file = path.join(dir, "icons.pen");
  try {
    const cols = 10, cell = 64, s = 48;
    const rows = Math.ceil(icons.length / cols);
    const lines = [`const F = Insert(document, { type: "frame", name: "icons", x: 0, y: 0, width: ${cols * cell}, height: ${rows * cell}, layout: "none", fill: "#FFFFFF" });`];
    icons.forEach(([library, icon], k) => {
      lines.push(`try { Insert(F, { type: "icon", library: ${JSON.stringify(library)}, icon: ${JSON.stringify(icon)}, x: ${(k % cols) * cell + (cell - s) / 2}, y: ${Math.floor(k / cols) * cell + (cell - s) / 2}, width: ${s}, height: ${s}, fill: "#000000" }); } catch (e) {}`);
    });
    lines.push(`Export([F], "png", ${JSON.stringify(dir)}); Print("F", F);`);
    const out = await run(file, lines.join("\n"));
    const id = /F (\S+)/.exec(out)?.[1];
    const png = fs.readdirSync(dir).find((f) => f.endsWith(".png") && (!id || f.includes(id))) ?? fs.readdirSync(dir).find((f) => f.endsWith(".png"));
    if (!png) return [];
    const img = readPng(path.join(dir, png));
    const k = img.width / (cols * cell);
    return icons
      .map(([library, icon], i) => ({ key: `${library}:${icon}`, mask: maskOf(crop(img, { x: (i % cols) * cell * k, y: Math.floor(i / cols) * cell * k, w: cell * k, h: cell * k })) }))
      .filter((c) => c.mask);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
