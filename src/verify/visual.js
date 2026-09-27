// Pixel comparison as a backstop for what the element comparison cannot see (images, icons,
// drawings) and the only signal for image-only sources: regions that differ, in design coordinates.
import { deltaE } from "./color.js";
import { cellMeans, crop, resize } from "./image.js";

const rgb = ([r, g, b]) => ({ r, g, b, a: 1 });

/**
 * Regions where the UI screenshot differs from the design render. The UI image is scaled to the
 * design render's width; both are compared in `cell`-sized blocks (mean color ΔE > `threshold`),
 * flagged blocks merge into regions, smallest ones dropped. `ignore` boxes (design coordinates)
 * are skipped, e.g. texts already compared as elements, whose anti-aliasing differs by renderer.
 */
export function pixelRegions(designImg, frame, uiImg, { cell = 8, threshold = 12, minCells = 2, ignore = [], max = 15, uiWidth = frame.w } = {}) {
  const k = designImg.width / frame.w; // design pixels per design unit
  // The screenshot at the design's pixel density; a wider device is compared where both overlap.
  const ui = resize(uiImg, Math.round(uiWidth * k));
  const w = Math.min(designImg.width, ui.width), h = Math.min(designImg.height, ui.height);
  const a = cellMeans(crop(designImg, { x: 0, y: 0, w, h }), cell);
  const b = cellMeans(crop(ui, { x: 0, y: 0, w, h }), cell);
  const inIgnored = (cx, cy) => {
    const x = ((cx + 0.5) * cell) / k, y = ((cy + 0.5) * cell) / k;
    return ignore.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  };
  const flagged = new Uint8Array(a.cols * a.rows);
  for (let cy = 0; cy < a.rows; cy++) {
    for (let cx = 0; cx < a.cols; cx++) {
      const i = cy * a.cols + cx;
      if (deltaE(rgb(a.cells[i]), rgb(b.cells[i])) > threshold && !inIgnored(cx, cy)) flagged[i] = 1;
    }
  }
  const regions = [];
  const seen = new Uint8Array(flagged.length);
  for (let start = 0; start < flagged.length; start++) {
    if (!flagged[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
    while (stack.length) {
      const i = stack.pop();
      const cx = i % a.cols, cy = Math.floor(i / a.cols);
      count++;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (nx < 0 || ny < 0 || nx >= a.cols || ny >= a.rows) continue;
        const j = ny * a.cols + nx;
        if (flagged[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (count < minCells) continue;
    regions.push({
      cells: count,
      box: { x: (minX * cell) / k, y: (minY * cell) / k, w: ((maxX - minX + 1) * cell) / k, h: ((maxY - minY + 1) * cell) / k },
    });
  }
  regions.sort((p, q) => q.cells - p.cells);
  const differentHeight = Math.abs(designImg.height - ui.height) > cell * 2 ? { design: designImg.height / k, ui: ui.height / k } : null;
  return { regions: regions.slice(0, max), dropped: Math.max(0, regions.length - max), differentHeight };
}

/** The smallest compared design nodes that cover most of a region, for naming it. */
export function nodesAt(design, region, limit = 3) {
  const r = region.box;
  const overlap = (b) => {
    const w = Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x), h = Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y);
    return w > 0 && h > 0 ? (w * h) / (r.w * r.h) : 0;
  };
  return design.nodes
    .map((n) => ({ n, o: overlap(n.box) }))
    .filter((x) => x.o >= 0.3)
    .sort((p, q) => p.n.box.w * p.n.box.h - q.n.box.w * q.n.box.h)
    .slice(0, limit)
    .map((x) => x.n);
}

/**
 * Whether a matched element looks different from its design node, comparing the two boxes'
 * pixels directly (for elements that moved with their anchor on a wider device, or fixed bars).
 * `uiScaled` is the screenshot already at the design render's density.
 */
export function boxDiffers(designImg, k, dBox, uiScaled, uBox, { cell = 6, threshold = 15, share = 0.15 } = {}) {
  const px = (b) => ({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k });
  const a = crop(designImg, px(dBox));
  let b = crop(uiScaled, px(uBox));
  if (!a.width || !a.height || !b.width || !b.height) return false;
  if (b.width !== a.width || b.height !== a.height) b = resize(b, a.width, a.height);
  const ma = cellMeans(a, cell), mb = cellMeans(b, cell);
  let bad = 0;
  for (let i = 0; i < ma.cells.length; i++) if (deltaE(rgb(ma.cells[i]), rgb(mb.cells[i])) > threshold) bad++;
  return bad / ma.cells.length > share;
}
