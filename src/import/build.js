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

/**
 * left / center / right from where the drawn line sits in the content box: centered on it, flush
 * with its right edge, else left (with the line's exact start). A full-width line uses the
 * captured text-align.
 */
function alignOf(el) {
  const tb = el.textBox, b = el.contentBox ?? el.box;
  if (tb && tb.w < b.w - 2) {
    const dc = Math.abs(tb.x + tb.w / 2 - (b.x + b.w / 2)), dr = Math.abs(tb.x + tb.w - (b.x + b.w)), dl = Math.abs(tb.x - b.x);
    if (dc <= 1.5 && dc < dl) return "center";
    if (dr <= 1.5 && dr < dl) return "right";
    return "left";
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

// "/" separates layer addresses (verify markers), so it never goes into a name.
export const safeName = (s) => String(s).replace(/\s*\/\s*/g, " – ");
const nameOf = (el) => {
  const marker = el.marker && String(el.marker).replace(/^.*:id\//, "").replace(/^pen:/, "");
  if (marker) return safeName(marker.split("/").pop());
  if (el.text) return safeName(el.text.replace(/\s+/g, " ").slice(0, 32));
  const sel = String(el.selector ?? "").split(">").pop().trim();
  return safeName(sel || el.tag || "Box");
};

/** A text's box inside its container: the content box, aligned where the drawn line is. */
function textPlacement(el, origin) {
  const cb = el.contentBox ?? el.box, tb = el.textBox;
  const align = alignOf(el);
  if (!tb) return { x: r2(cb.x - origin.x), y: r2(cb.y - origin.y), width: r2(cb.w), textAlign: align };
  // Left: from the line's start to the content box's end; right: from the content start to the
  // line's end; center: the whole content box (the line is centered in it).
  const y = r2(tb.y - origin.y); // the first line box's top
  if (align === "left") return { x: r2(tb.x - origin.x), y, width: r2(Math.max(tb.w + 1, cb.x + cb.w - tb.x)), textAlign: align };
  if (align === "right") return { x: r2(cb.x - origin.x), y, width: r2(Math.max(tb.w + 1, tb.x + tb.w - cb.x)), textAlign: align };
  return { x: r2(cb.x - origin.x), y, width: r2(Math.max(tb.w + 1, cb.w)), textAlign: align };
}

/**
 * Node specs in parent-first order: [{ key, parent (key or null for the screen), props }].
 * Elements that paint nothing are dropped and their children re-parented to the nearest kept
 * ancestor, so the imported tree is only as deep as what is visible.
 */
export function buildSpecs(snapshot, { tokens = [], images = null, frameHeight } = {}) {
  const byIndex = new Map(snapshot.elements.map((el) => [el.i, el]));
  const kept = new Map(); // element index -> spec key (frames only: a text node cannot hold children)
  const specs = [];
  const vh = snapshot.viewport?.h;
  // A bar fixed to the bottom of the viewport sits at the bottom of a taller imported frame.
  const shiftOf = (el) => (el.fixed && vh && frameHeight && frameHeight > vh + 1 && el.box.y + el.box.h / 2 > vh / 2 ? frameHeight - vh : 0);
  const placed = new Map(); // element index -> its box in the imported frame
  const boxOf = (el) => {
    if (placed.has(el.i)) return placed.get(el.i);
    let dy = shiftOf(el);
    for (let p = el.parent !== undefined ? byIndex.get(el.parent) : null; p && !dy; p = p.parent !== undefined ? byIndex.get(p.parent) : null) dy = shiftOf(p);
    const b = { ...el.box, y: el.box.y + dy };
    placed.set(el.i, b);
    return b;
  };
  const keyOf = (el) => {
    for (let p = el.parent !== undefined ? byIndex.get(el.parent) : null; p; p = p.parent !== undefined ? byIndex.get(p.parent) : null) if (kept.has(p.i)) return { key: kept.get(p.i), box: boxOf(p) };
    return { key: null, box: { x: 0, y: 0 } };
  };
  for (const el of snapshot.elements) {
    const bg = tokenOrHex(el.bg, tokens);
    const border = el.borderWidth > 0 ? tokenOrHex(el.borderColor, tokens) : null;
    const visual = VISUAL_TAGS.test(el.tag ?? "") || el.icon;
    const text = el.text && !el.icon ? el.text : null;
    if (!bg && !border && !visual && !text && !el.marker) continue;
    const { key: parent, box: pbox } = keyOf(el);
    const own = boxOf(el);
    const x = r2(own.x - pbox.x), y = r2(own.y - pbox.y), w = r2(own.w), h = r2(own.h);
    const shifted = own.y - el.box.y;
    const moved = (b) => (b ? { ...b, y: b.y + shifted } : b);
    const key = `n${specs.length}`;
    const name = nameOf(el);
    if (text && !bg && !border && !visual) {
      const props = { type: "text", name, content: text, textGrowth: "fixed-width", ...textPlacement({ ...el, box: own, contentBox: moved(el.contentBox), textBox: moved(el.textBox) }, pbox) };
      Object.assign(props, textStyle(el, tokens));
      specs.push({ key, parent, props });
      continue; // not kept: its children (inline code, inputs) go to the nearest frame
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
      const tprops = { type: "text", name: `${name} text`, content: text, textGrowth: "fixed-width", ...textPlacement({ ...el, box: own, contentBox: moved(el.contentBox), textBox: moved(el.textBox) }, own) };
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

/**
 * execute snippets creating the specs under one new screen frame, `batch` nodes per call. Each
 * import keeps its key -> id map under its own global (agents importing into one document in
 * the app do not collide) and removes it at the end; a lost map fails loudly.
 */
export function snippets({ screen, specs, batch = 200, key = `__penImport_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` }) {
  const out = [];
  const G = `globalThis[${JSON.stringify(key)}]`;
  out.push(`${G} = { root: Insert(document, ${JSON.stringify(screen)}) };\nPrint("ROOT", ${G}.root);`);
  for (let i = 0; i < specs.length; i += batch) {
    const part = specs.slice(i, i + batch).map((s) => [s.key, s.parent, s.props]);
    out.push(
      `const M = ${G};\nif (!M) throw new Error("the import's state was lost (the editor restarted between batches); delete the partial frame and import again");\nfor (const [key, parent, props] of ${JSON.stringify(part)}) M[key] = Insert(parent ? M[parent] : M.root, props);\nPrint("DONE", ${Math.min(i + batch, specs.length)});`,
    );
  }
  out.push(`delete ${G};\nPrint("CLEAN", 1);`);
  return out;
}
