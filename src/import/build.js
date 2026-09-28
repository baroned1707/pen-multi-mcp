// Code -> design: turns a UI snapshot (from capture) into .pen node specs — painted boxes as
// frames, texts as text nodes, images and icons as crops of the screenshot — placed absolutely
// inside one screen frame, with colors mapped to the document's tokens where they match.
import fs from "node:fs";
import path from "node:path";
import { deltaE, parseColor, toHex } from "../verify/color.js";
import { crop, writePng } from "../verify/image.js";

const VISUAL_TAGS = /^(img|svg|canvas|video|picture|rctimageview|imageview|image)$/i;
const r2 = (v) => Math.round(v * 100) / 100;

/** A color as "$token" when a token has that value (ΔE < 1, alpha equal), else hex. */
export function tokenOrHex(color, tokens) {
  const c = parseColor(color);
  if (!c || c.a <= 0.01) return null;
  const t = tokens.find((x) => Math.abs((x.color.a ?? 1) - (c.a ?? 1)) < 0.02 && deltaE(x.color, c) < 1);
  return t ? `$${t.name}` : toHex(c);
}

/** left / center / right: the captured text-align, or where the drawn line sits in its box (flex centering). */
function alignOf(el) {
  const tb = el.textBox, b = el.box;
  if (tb && tb.w < b.w - 4) {
    const dc = Math.abs(tb.x + tb.w / 2 - (b.x + b.w / 2)), dl = Math.abs(tb.x - b.x), dr = Math.abs(tb.x + tb.w - (b.x + b.w));
    if (dc < 2 && dc < dl) return "center";
    if (dr < 2 && dr < dl) return "right";
  }
  return el.textAlign === "center" || el.textAlign === "right" ? el.textAlign : "left";
}

const textStyle = (el, tokens) => {
  const out = {};
  const fg = tokenOrHex(el.fg, tokens);
  if (fg) out.fill = fg;
  if (el.fontSize) out.fontSize = r2(el.fontSize);
  if (el.fontWeight) out.fontWeight = String(el.fontWeight);
  if (el.fontFamily) out.fontFamily = el.fontFamily;
  if (el.lineHeight && el.fontSize) out.lineHeight = r2(el.lineHeight / el.fontSize);
  return out;
};

const nameOf = (el) => {
  const marker = el.marker && String(el.marker).replace(/^.*:id\//, "").replace(/^pen:/, "");
  if (marker) return marker.split("/").pop();
  if (el.text) return el.text.replace(/\s+/g, " ").slice(0, 32);
  const sel = String(el.selector ?? "").split(">").pop().trim();
  return sel || el.tag || "Box";
};

/**
 * Node specs in parent-first order: [{ key, parent (key or null for the screen), props }].
 * Elements that paint nothing are dropped and their children re-parented to the nearest kept
 * ancestor, so the imported tree is only as deep as what is visible.
 */
export function buildSpecs(snapshot, { tokens = [], images = null } = {}) {
  const byIndex = new Map(snapshot.elements.map((el) => [el.i, el]));
  const kept = new Map(); // element index -> spec key
  const specs = [];
  const keyOf = (el) => {
    for (let p = el.parent !== undefined ? byIndex.get(el.parent) : null; p; p = p.parent !== undefined ? byIndex.get(p.parent) : null) if (kept.has(p.i)) return { key: kept.get(p.i), box: p.box };
    return { key: null, box: { x: 0, y: 0 } };
  };
  for (const el of snapshot.elements) {
    const bg = tokenOrHex(el.bg, tokens);
    const border = el.borderWidth > 0 ? tokenOrHex(el.borderColor, tokens) : null;
    const visual = VISUAL_TAGS.test(el.tag ?? "") || el.icon;
    const text = el.text && !el.icon ? el.text : null;
    if (!bg && !border && !visual && !text && !el.marker) continue;
    const { key: parent, box: pbox } = keyOf(el);
    const x = r2(el.box.x - pbox.x), y = r2(el.box.y - pbox.y), w = r2(el.box.w), h = r2(el.box.h);
    const key = `n${specs.length}`;
    const name = nameOf(el);
    if (text && !bg && !border && !visual) {
      // The block's width, the drawn line's top, and the alignment that puts the line where it is.
      const tb = el.textBox;
      const props = { type: "text", name, content: text, x, y: tb ? r2(tb.y - pbox.y) : y, width: w, textGrowth: "fixed-width", textAlign: alignOf(el) };
      Object.assign(props, textStyle(el, tokens));
      specs.push({ key, parent, props });
      kept.set(el.i, key);
      continue;
    }
    const props = { type: "frame", name, x, y, width: w, height: h, layout: "none" };
    if (bg) props.fill = bg;
    if (visual && images) {
      const url = images(el);
      if (url) props.fill = { type: "image", url, mode: "fill" };
    }
    if (el.radius) props.cornerRadius = r2(Math.min(el.radius, w / 2, h / 2));
    if (border) {
      props.stroke = border;
      props.strokeWidth = r2(el.borderWidth);
    }
    specs.push({ key, parent, props });
    kept.set(el.i, key);
    if (text) {
      // A painted element with its own text: the text goes inside it.
      const tb = el.textBox;
      const tprops = { type: "text", name: `${name} text`, content: text, x: 0, y: tb ? r2(tb.y - el.box.y) : 0, width: w, textGrowth: "fixed-width", textAlign: alignOf(el) };
      Object.assign(tprops, textStyle(el, tokens));
      specs.push({ key: `n${specs.length}`, parent: key, props: tprops });
    }
  }
  return specs;
}

/** Writes crops of the screenshot for image/icon elements next to the .pen; returns a url maker. */
export function imageCropper({ img, scale, penFile, prefix }) {
  const dir = path.join(path.dirname(penFile), "images");
  let n = 0;
  return (el) => {
    const b = { x: el.box.x * scale, y: el.box.y * scale, w: el.box.w * scale, h: el.box.h * scale };
    if (b.w < 2 || b.h < 2 || b.w * b.h > 4_000_000) return null;
    const part = crop(img, b);
    if (!part.width || !part.height) return null;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${prefix}-${n++}.png`);
    writePng(file, part);
    return path.relative(path.dirname(penFile), file);
  };
}

/** execute snippets creating the specs under one new screen frame, `batch` nodes per call. */
export function snippets({ screen, specs, batch = 200 }) {
  const out = [];
  out.push(`globalThis.__penImport = { root: Insert(document, ${JSON.stringify(screen)}) };\nPrint("ROOT", __penImport.root);`);
  for (let i = 0; i < specs.length; i += batch) {
    const part = specs.slice(i, i + batch).map((s) => [s.key, s.parent, s.props]);
    out.push(`const M = globalThis.__penImport;\nfor (const [key, parent, props] of ${JSON.stringify(part)}) M[key] = Insert(parent ? M[parent] : M.root, props);\nPrint("DONE", ${Math.min(i + batch, specs.length)});`);
  }
  return out;
}
