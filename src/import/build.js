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

// A number as the one token with that value, else the number.
const numOrToken = (v, map) => map?.get(r2(v)) ?? r2(v);

const textStyle = (el, tokens, numbers) => {
  const out = {};
  const fg = tokenOrHex(el.fg, tokens);
  if (fg) out.fill = fg;
  if (el.fontSize) out.fontSize = numOrToken(el.fontSize, numbers?.fontSize);
  if (el.fontWeight) out.fontWeight = String(el.fontWeight);
  if (el.fontFamily) out.fontFamily = el.fontFamily;
  if (el.lineHeight && el.fontSize) out.lineHeight = r2(el.lineHeight / el.fontSize);
  if (el.letterSpacing) out.letterSpacing = r2(el.letterSpacing);
  return out;
};

// "/" separates layer addresses (verify markers), so it never goes into a name.
export const safeName = (s) => String(s).replace(/\s*\/\s*/g, " – ");
const words = (s) => String(s).replace(/[-_]+/g, " ").replace(/\b\w/, (c) => c.toUpperCase());
const nameOf = (el) => {
  const marker = el.marker && String(el.marker).replace(/^.*:id\//, "").replace(/^pen:/, "");
  if (marker) return safeName(marker.split("/").pop());
  // A text layer is named by what it says; a box by what the code calls it.
  const h = el.nameHint ?? {};
  if (!el.text || el.bg || el.borderWidth > 0) {
    const named = h.component ?? h.label ?? (h.id && words(h.id)) ?? (h.cls && words(h.cls));
    if (named) return safeName(named);
  }
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
  // One line in the code must stay one line in the design, whose font metrics differ slightly:
  // it grows with its content from where the line starts, instead of wrapping at a fixed width.
  if (el.fontSize && tb.h < (el.lineHeight ?? el.fontSize * 1.2) * 1.5) return { x: r2(tb.x - origin.x), y, textGrowth: "auto", textAlign: align };
  if (align === "left") return { x: r2(tb.x - origin.x), y, width: r2(Math.max(tb.w + 1, cb.x + cb.w - tb.x)), textAlign: align };
  if (align === "right") return { x: r2(cb.x - origin.x), y, width: r2(Math.max(tb.w + 1, tb.x + tb.w - cb.x)), textAlign: align };
  return { x: r2(cb.x - origin.x), y, width: r2(Math.max(tb.w + 1, cb.w)), textAlign: align };
}

/**
 * Node specs in parent-first order: [{ key, parent (key or null for the screen), props }].
 * Elements that paint nothing are dropped and their children re-parented to the nearest kept
 * ancestor, so the imported tree is only as deep as what is visible.
 */
export function buildSpecs(snapshot, { tokens = [], numbers = null, components = null, images = null, icons = null, frameHeight, autoLayout = true, makeComponents: make = false } = {}) {
  const byIndex = new Map(snapshot.elements.map((el) => [el.i, el]));
  const kept = new Map(); // element index -> spec key (frames only: a text node cannot hold children)
  const specs = [];
  const vh = snapshot.viewport?.h;
  // A bar fixed to the bottom edge of the viewport sits at the bottom of a taller imported frame
  // (sticky elements and fixed toasts elsewhere stay where the page showed them).
  const shiftOf = (el) => (el.fixed && vh && frameHeight && frameHeight > vh + 1 && Math.abs(vh - (el.box.y + el.box.h)) <= 1 ? frameHeight - vh : 0);
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
  // A paragraph's own boxes (inline code, badges) must paint below its text: a text spec waits
  // until the elements inside it are emitted.
  const pending = [];
  let seq = 0; // spec keys are unique even while texts wait in `pending`
  const isInside = (el, ancestorIndex) => {
    for (let p = el.parent !== undefined ? byIndex.get(el.parent) : null; p; p = p.parent !== undefined ? byIndex.get(p.parent) : null) if (p.i === ancestorIndex) return true;
    return false;
  };
  const flushPending = (el) => {
    while (pending.length && !(el && isInside(el, pending.at(-1).owner))) specs.push(pending.pop().spec);
  };
  // Elements whose marker names a design component become instances; what is inside them is the
  // component's (texts become overrides when they line up with the component's texts).
  const childCount = new Map();
  const childrenOf = new Map();
  for (const el of snapshot.elements) {
    if (el.parent === undefined) continue;
    childCount.set(el.parent, (childCount.get(el.parent) ?? 0) + 1);
    (childrenOf.get(el.parent) ?? childrenOf.set(el.parent, []).get(el.parent)).push(el);
  }
  // Flexbox as captured, or a block whose children stack top to bottom with even gaps (a column).
  const layouts = new Map();
  for (const el of snapshot.elements) {
    if (el.layout) layouts.set(el.i, el.layout);
    else if (autoLayout) {
      const st = stackLayout(el, childrenOf.get(el.i) ?? []);
      if (st) layouts.set(el.i, st);
    }
  }
  const instanceOf = new Map(); // element index -> component
  const insideInstance = (el) => {
    for (let p = el.parent !== undefined ? byIndex.get(el.parent) : null; p; p = p.parent !== undefined ? byIndex.get(p.parent) : null) if (instanceOf.has(p.i)) return p;
    return null;
  };
  for (const el of snapshot.elements) {
    flushPending(el);
    if (insideInstance(el)) continue;
    let comp = el.marker && components?.get(String(el.marker).replace(/^.*:id\//, "").replace(/^pen:/, ""));
    // A marker naming the component by id is proof. By name ("Row", "Card") it is only a hint:
    // taken when the element shows as many texts as the component has, so every one is overridden.
    if (comp && !comp.byId) {
      const shown = snapshot.elements.filter((c) => c.text && !c.icon && c.i !== el.i && isInside(c, el.i)).length || (el.text ? 1 : 0);
      if (shown !== comp.texts.length) comp = null;
    }
    if (comp) {
      const { key: parent, box: pbox } = keyOf(el);
      const own = boxOf(el);
      instanceOf.set(el.i, comp);
      const props = { type: "ref", ref: comp.id, name: nameOf(el), x: r2(own.x - pbox.x), y: r2(own.y - pbox.y), width: r2(own.w), height: r2(own.h) };
      const texts = snapshot.elements.filter((c) => c.text && !c.icon && c.i !== el.i && isInside(c, el.i)).map((c) => c.text);
      if (el.text && !texts.length) texts.push(el.text);
      if (texts.length && texts.length === comp.texts.length) {
        const descendants = {};
        comp.texts.forEach((t, i) => {
          if (t.content !== texts[i]) descendants[t.id] = { content: texts[i] };
        });
        if (Object.keys(descendants).length) props.descendants = descendants;
      }
      specs.push({ key: `n${seq++}`, parent, props, el: el.i });
      continue;
    }
    const bg = tokenOrHex(el.bg, tokens);
    const border = el.borderWidth > 0 ? tokenOrHex(el.borderColor, tokens) : null;
    const visual = VISUAL_TAGS.test(el.tag ?? "") || el.icon;
    const text = el.text && !el.icon ? el.text : null;
    // An unpainted flex container with several children is kept as a structural frame, so its
    // children can be laid out by it (auto layout) instead of moving up to a painted ancestor.
    const structural = autoLayout && layouts.get(el.i) && (childCount.get(el.i) ?? 0) >= 2;
    if (!bg && !border && !visual && !text && !el.marker && !structural) continue;
    const { key: parent, box: pbox } = keyOf(el);
    const own = boxOf(el);
    const x = r2(own.x - pbox.x), y = r2(own.y - pbox.y), w = r2(own.w), h = r2(own.h);
    const shifted = own.y - el.box.y;
    const moved = (b) => (b ? { ...b, y: b.y + shifted } : b);
    const key = `n${seq++}`;
    const name = nameOf(el);
    if (text && !bg && !border && !visual) {
      const props = { type: "text", name, content: text, textGrowth: "fixed-width", ...textPlacement({ ...el, box: own, contentBox: moved(el.contentBox), textBox: moved(el.textBox) }, pbox) };
      Object.assign(props, textStyle(el, tokens, numbers));
      pending.push({ owner: el.i, spec: { key, parent, props, el: el.i } });
      continue; // not kept: its children (inline code, inputs) go to the nearest frame
    }
    const props = { type: "frame", name, x, y, width: w, height: h, layout: "none" };
    if (bg) props.fill = bg;
    if (visual && images) {
      const url = images(el);
      if (url) props.fill = { type: "image", url, mode: "fill" };
    }
    if (el.radius) props.cornerRadius = numOrToken(Math.min(el.radius, w / 2, h / 2), numbers?.radius);
    if (border) {
      props.stroke = border;
      props.strokeWidth = r2(el.borderWidth);
    }
    // An icon recognised among the document's icons becomes an icon node (its crop stays the fallback).
    const iconHit = visual && icons?.get(el.i);
    if (iconHit) {
      const [library, icon] = iconHit.split(":");
      const iprops = { type: "icon", name, library, icon, x, y, width: w, height: h };
      const fg = tokenOrHex(el.fg, tokens);
      if (fg) iprops.fill = fg;
      specs.push({ key, parent, props: iprops, fallback: props, el: el.i });
      kept.set(el.i, key);
      continue;
    }
    specs.push({ key, parent, props, el: el.i });
    kept.set(el.i, key);
    if (text) {
      // A painted element with its own text: the text goes inside it.
      const tprops = { type: "text", name: `${name} text`, content: text, textGrowth: "fixed-width", ...textPlacement({ ...el, box: own, contentBox: moved(el.contentBox), textBox: moved(el.textBox) }, own) };
      Object.assign(tprops, textStyle(el, tokens, numbers));
      specs.push({ key: `n${seq++}`, parent: key, props: tprops, el: el.i, ownText: true });
    }
  }
  flushPending(null);
  if (autoLayout) {
    applyRows(specs, byIndex, layouts);
    applyAutoLayout(specs, byIndex, layouts);
  }
  if (make) makeComponents(specs);
  return specs;
}

/**
 * Runs of three or more sibling frames with the same structure (types and sizes, recursively)
 * become one component: the first is made reusable, the others instances of it whose texts are
 * overrides, matched in order. Groups whose texts do not line up are left alone. Sets
 * `specs.components` to [{ name, count }].
 */
export function makeComponents(specs) {
  const kids = new Map();
  for (const s of specs) if (s.parent) (kids.get(s.parent) ?? kids.set(s.parent, []).get(s.parent)).push(s);
  const sig = (s) => `${s.props.type}:${Math.round(s.props.width ?? 0)}x${Math.round(s.props.height ?? 0)}(${(kids.get(s.key) ?? []).map(sig).join(",")})`;
  const subtree = (s) => (kids.get(s.key) ?? []).flatMap((c) => [c, ...subtree(c)]);
  // What an instance may override, per node: anything that makes it look different.
  const LOOK = ["content", "fill", "stroke", "strokeWidth", "icon", "library", "fontWeight", "fontSize", "fontFamily", "lineHeight", "letterSpacing", "textAlign", "cornerRadius", "opacity", "enabled"];
  const diff = (m, s) => {
    const out = {};
    for (const k of LOOK) if (JSON.stringify(m.props[k]) !== JSON.stringify(s.props[k]) && s.props[k] !== undefined) out[k] = s.props[k];
    return out;
  };
  const made = [];
  const drop = new Set();
  for (const [, list] of kids) {
    const groups = new Map();
    for (const s of list) if (s.props.type === "frame" && (kids.get(s.key) ?? []).length) (groups.get(sig(s)) ?? groups.set(sig(s), []).get(sig(s))).push(s);
    for (const g of groups.values()) {
      if (g.length < 3) continue;
      const [first, ...rest] = g;
      const master = subtree(first);
      first.props = { ...first.props, reusable: true };
      for (const s of rest) {
        // Same structure, so the same order: node k of this copy is node k of the component.
        const mine = subtree(s);
        const byKey = {};
        master.forEach((m, k) => {
          const d = diff(m, mine[k]);
          if (Object.keys(d).length) byKey[m.key] = d;
        });
        for (const d of mine) drop.add(d);
        const own = diff(first, s);
        s.props = { type: "ref", refKey: first.key, name: s.props.name, x: s.props.x, y: s.props.y, width: s.props.width, height: s.props.height, ...own, ...(Object.keys(byKey).length ? { descendantsByKey: byKey } : {}) };
      }
      made.push({ name: first.props.name, count: g.length });
    }
  }
  for (let i = specs.length - 1; i >= 0; i--) if (drop.has(specs[i])) specs.splice(i, 1);
  specs.components = made;
  return specs;
}

/**
 * Grids and wrapping flex rows as rows of auto layout: children grouped by their top edge (±2 px);
 * one row → horizontal, one per row → vertical, several rows → a vertical frame of horizontal row
 * frames (inserted into `specs`). Row gaps and column gaps come from the layout. Everything is
 * marked `auto`, so import_ui checks it against the page and puts back what does not match.
 */
export function applyRows(specs, byIndex, layouts = new Map()) {
  for (let s = 0; s < specs.length; s++) {
    const sp = specs[s];
    if (sp.props.type !== "frame" || sp.rows) continue;
    const el = byIndex.get(sp.el);
    const lay = el && (layouts.get(el.i) ?? el.layout);
    if (!lay || !(lay.dir === "grid" || (lay.wrap && !/column|reverse/.test(lay.dir)))) continue;
    const kids = specs.filter((k) => k.parent === sp.key);
    if (kids.length < 2 || !kids.every((k) => byIndex.get(k.el)?.parent === el.i && typeof k.props.x === "number" && typeof k.props.y === "number")) continue;
    const rows = [];
    for (const k of [...kids].sort((a, b) => a.props.y - b.props.y || a.props.x - b.props.x)) {
      const row = rows.find((r) => Math.abs(r.y - k.props.y) <= 2);
      if (row) row.kids.push(k);
      else rows.push({ y: k.props.y, kids: [k] });
    }
    rows.forEach((r) => r.kids.sort((a, b) => a.props.x - b.props.x));
    const pad = lay.padding.map(r2);
    const base = { padding: pad, justifyContent: "start", alignItems: "start" };
    if (rows.length === 1) {
      Object.assign(sp.props, { layout: "horizontal", gap: r2(lay.colGap ?? lay.gap ?? 0), ...base });
    } else if (rows.every((r) => r.kids.length === 1)) {
      Object.assign(sp.props, { layout: "vertical", gap: r2(lay.rowGap ?? 0), ...base });
    } else {
      // A frame per row, inserted before the row's first child so it exists when they are.
      rows.forEach((r, i) => {
        const x0 = Math.min(...r.kids.map((k) => k.props.x)), y0 = Math.min(...r.kids.map((k) => k.props.y));
        const x1 = Math.max(...r.kids.map((k) => k.props.x + (k.props.width ?? 0))), y1 = Math.max(...r.kids.map((k) => k.props.y + (k.props.height ?? 0)));
        const key = `${sp.key}r${i}`;
        const rowSpec = { key, parent: sp.key, props: { type: "frame", name: `Row ${i + 1}`, x: r2(x0), y: r2(y0), width: r2(x1 - x0), height: r2(y1 - y0), layout: "horizontal", gap: r2(lay.colGap ?? 0), justifyContent: "start", alignItems: "start" }, auto: true, rows: true };
        for (const k of r.kids) {
          k.parent = key;
          k.props = { ...k.props, x: r2(k.props.x - x0), y: r2(k.props.y - y0) };
        }
        specs.splice(specs.indexOf(r.kids.reduce((a, b) => (specs.indexOf(a) < specs.indexOf(b) ? a : b))), 0, rowSpec);
      });
      Object.assign(sp.props, { layout: "vertical", gap: r2(lay.rowGap ?? 0), ...base });
    }
    sp.auto = true;
    sp.rows = true; // applyAutoLayout leaves it as is
  }
  return specs;
}

/**
 * A block's children as a column: at least two, each below the previous one, with the same gap
 * between all of them (±0.5px), none positioned. Returns a flex-like layout, or null.
 */
export function stackLayout(el, kids) {
  if (kids.length < 2 || kids.some((k) => k.fixed || k.absolute || k.sticky)) return null;
  const gaps = [];
  for (let i = 1; i < kids.length; i++) gaps.push(kids[i].box.y - (kids[i - 1].box.y + kids[i - 1].box.h));
  if (gaps.some((g) => g < -0.5) || Math.max(...gaps) - Math.min(...gaps) > 0.5) return null;
  const left = Math.min(...kids.map((k) => k.box.x));
  const right = Math.max(...kids.map((k) => k.box.x + k.box.w));
  const b = el.box;
  const last = kids.at(-1).box;
  return { dir: "column", gap: Math.max(0, gaps[0]), padding: [kids[0].box.y - b.y, b.x + b.w - right, b.y + b.h - (last.y + last.h), left - b.x].map((v) => Math.max(0, v)), align: "flex-start", justify: "flex-start", inferred: true };
}

const JUSTIFY = { normal: "start", "flex-start": "start", start: "start", left: "start", center: "center", "flex-end": "end", end: "end", right: "end", "space-between": "space_between", "space-around": "space_around", "space-evenly": "space_around" };
const ALIGN = { "flex-start": "start", start: "start", "self-start": "start", center: "center", "flex-end": "end", end: "end", "self-end": "end" };

/**
 * Frames whose element is a flex container become auto layout — only where the imported children
 * are exactly the element's own flex items (no dropped wrapper between them, nothing positioned,
 * no wrapping or reversed direction). Children keep their x/y, so switching a frame back to
 * layout "none" restores the measured placement (import_ui does that where the engine's layout
 * does not reproduce the page). Marks each such spec with `auto: true`.
 */
export function applyAutoLayout(specs, byIndex, layouts = new Map()) {
  const children = new Map();
  for (const sp of specs) if (sp.parent) (children.get(sp.parent) ?? children.set(sp.parent, []).get(sp.parent)).push(sp);
  for (const sp of specs) {
    if (sp.props.type !== "frame" || sp.rows) continue;
    const el = byIndex.get(sp.el);
    const lay = el && (layouts.get(el.i) ?? el.layout);
    if (!lay || lay.wrap || lay.dir === "grid" || /reverse/.test(lay.dir)) continue;
    const kids = children.get(sp.key) ?? [];
    if (!kids.length) continue;
    const flexItems = kids.every((k) => {
      const kel = byIndex.get(k.el);
      return (k.ownText || kel?.parent === el.i) && !kel?.fixed && !kel?.absolute && !kel?.sticky;
    });
    if (!flexItems) continue;
    const props = { layout: lay.dir.startsWith("column") ? "vertical" : "horizontal", gap: r2(lay.gap ?? 0), padding: lay.padding.map(r2) };
    if (JUSTIFY[lay.justify]) props.justifyContent = JUSTIFY[lay.justify];
    if (ALIGN[lay.align]) props.alignItems = ALIGN[lay.align];
    Object.assign(sp.props, props);
    sp.auto = true;
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
    const part = specs.slice(i, i + batch).map((s) => [s.key, s.parent, s.props, s.fallback ?? null]);
    out.push(
      `const M = ${G};\nif (!M) throw new Error("the import's state was lost (the editor restarted between batches); delete the partial frame and import again");\nlet FB = 0;\nfor (const [key, parent, props, fallback] of ${JSON.stringify(part)}) {\n  if (props.refKey) { props.ref = M[props.refKey]; delete props.refKey; }\n  if (props.descendantsByKey) { props.descendants = Object.fromEntries(Object.entries(props.descendantsByKey).map(([k, v]) => [M[k], v])); delete props.descendantsByKey; }\n  try { M[key] = Insert(parent ? M[parent] : M.root, props); }\n  catch (e) { if (!fallback) throw e; M[key] = Insert(parent ? M[parent] : M.root, fallback); FB++; }\n}\nPrint("DONE", ${Math.min(i + batch, specs.length)}, FB);`,
    );
  }
  out.push(`Print("KEYS", JSON.stringify(Object.fromEntries(Object.entries(${G}).filter(([k]) => k !== "root"))));\ndelete ${G};\nPrint("CLEAN", 1);`);
  return out;
}
