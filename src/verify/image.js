// Minimal raster helpers on top of pngjs: read/write, area-average scaling, color sampling,
// stacking images, and drawing numbered boxes for the contact sheet.
import fs from "node:fs";
import { PNG } from "pngjs";

/** { width, height, data: RGBA Uint8Array } */
export const readPng = (file) => {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
};
export const readPngBuffer = (buf) => {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
};

export function writePng(file, img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  fs.writeFileSync(file, PNG.sync.write(png));
}
export function pngBuffer(img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return PNG.sync.write(png);
}

export const blank = (width, height, [r, g, b] = [255, 255, 255]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
};

/** Pixel at (x, y) composited over white. */
function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  const a = img.data[i + 3] / 255;
  return [img.data[i] * a + 255 * (1 - a), img.data[i + 1] * a + 255 * (1 - a), img.data[i + 2] * a + 255 * (1 - a)];
}

/** Resizes by averaging the source area behind each target pixel (good for downscaling screenshots). */
export function resize(img, width, height = Math.max(1, Math.round((img.height * width) / img.width))) {
  width = Math.max(1, Math.round(width));
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width, sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = px(img, xx, yy);
          r += p[0];
          g += p[1];
          b += p[2];
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

export function crop(img, { x, y, w, h }) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(0, Math.min(img.width - x, Math.round(w)));
  h = Math.max(0, Math.min(img.height - y, Math.round(h)));
  const out = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy++) out.set(img.data.subarray(((y + yy) * img.width + x) * 4, ((y + yy) * img.width + x + w) * 4), yy * w * 4);
  return { width: w, height: h, data: out };
}

/**
 * Colors inside a box, quantized to 4 bits per channel: the most frequent is `bg`; for text, the
 * most frequent color clearly different from bg is `fg`. `scale` maps logical units to pixels.
 */
export function sampleColors(img, box, scale = 1, distinct = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 90) {
  const x0 = Math.max(0, Math.floor(box.x * scale)), y0 = Math.max(0, Math.floor(box.y * scale));
  const x1 = Math.min(img.width, Math.ceil((box.x + box.w) * scale)), y1 = Math.min(img.height, Math.ceil((box.y + box.h) * scale));
  if (x1 <= x0 || y1 <= y0) return {};
  const counts = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000))); // ≤ ~20k samples
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const [r, g, b] = px(img, x, y);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = counts.get(key);
      if (e) {
        e.n++;
        e.r += r;
        e.g += g;
        e.b += b;
      } else counts.set(key, { n: 1, r, g, b });
    }
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n).map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);
  const bg = ranked[0];
  const fg = ranked.find((c) => distinct(c, bg));
  const rgb = (c) => (c ? { r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), a: 1 } : undefined);
  return { bg: rgb(bg), fg: rgb(fg) };
}

/** Mean color of each cell × cell block, as [r, g, b] per cell in row-major order. */
export function cellMeans(img, cell) {
  const cols = Math.ceil(img.width / cell), rows = Math.ceil(img.height / cell);
  const out = new Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = cy * cell; y < Math.min(img.height, (cy + 1) * cell); y++) {
        for (let x = cx * cell; x < Math.min(img.width, (cx + 1) * cell); x++) {
          const p = px(img, x, y);
          r += p[0];
          g += p[1];
          b += p[2];
          n++;
        }
      }
      out[cy * cols + cx] = [r / n, g / n, b / n];
    }
  }
  return { cols, rows, cells: out };
}

/** Places images side by side (top-aligned) with a gap, on a light gray canvas. */
export function hstack(images, gap = 16) {
  const width = images.reduce((s, i) => s + i.width, 0) + gap * (images.length + 1);
  const height = Math.max(...images.map((i) => i.height)) + gap * 2;
  const out = blank(width, height, [236, 236, 236]);
  let x = gap;
  for (const img of images) {
    paste(out, img, x, gap);
    x += img.width + gap;
  }
  return out;
}

export function vstack(images, gap = 0) {
  const width = Math.max(...images.map((i) => i.width));
  const height = images.reduce((s, i) => s + i.height, 0) + gap * Math.max(0, images.length - 1);
  const out = blank(width, height, [236, 236, 236]);
  let y = 0;
  for (const img of images) {
    paste(out, img, 0, y);
    y += img.height + gap;
  }
  return out;
}

export function paste(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= dst.width) continue;
      const [r, g, b] = px(src, x, y);
      const o = (ty * dst.width + tx) * 4;
      dst.data[o] = r;
      dst.data[o + 1] = g;
      dst.data[o + 2] = b;
      dst.data[o + 3] = 255;
    }
  }
}

function fill(img, x0, y0, w, h, [r, g, b]) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
}

export function strokeRect(img, { x, y, w, h }, color, t = 2) {
  x = Math.round(x);
  y = Math.round(y);
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  fill(img, x, y, w, t, color);
  fill(img, x, y + h - t, w, t, color);
  fill(img, x, y, t, h, color);
  fill(img, x + w - t, y, t, h, color);
}

// 3×5 digits for issue numbers on the contact sheet.
const DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];

/** Draws a number on a colored tag at (x, y); returns the tag width. */
export function label(img, x, y, n, color, scale = 3) {
  const s = String(n);
  const w = s.length * 4 * scale + scale, h = 7 * scale;
  fill(img, Math.round(x), Math.round(y), w, h, color);
  s.split("").forEach((d, i) => {
    const bits = DIGITS[Number(d)];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (bits[r * 3 + c] === "1") fill(img, Math.round(x) + scale + (i * 4 + c) * scale, Math.round(y) + scale + r * scale, scale, scale, [255, 255, 255]);
  });
  return w;
}
