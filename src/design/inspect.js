// Formats a design model for agents: an outline (one line per node), the screen's sections and
// shell, per-node code hints (Tailwind, CSS, React Native), and a JSON form for scripts.
import { addresses } from "./model.js";

const num = (v) => (typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v));
const clip = (s, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const visibleChildren = (n) => n.children.filter((c) => !c.hidden);
/** Frames without a layout property lay out as a horizontal row; `none` means absolute; groups position children absolutely. */
const layoutOf = (n) => (n.type === "group" ? "none" : n.type !== "frame" ? null : n.layout ?? "horizontal");

/**
 * The color a node paints with, from any fill shape the schema allows: "$token", "#hex",
 * { type: "color", color }, or an array of fills. Gradients and images are reported as such.
 */
export function primaryFill(raw, resolved) {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const rlist = Array.isArray(resolved) ? resolved : [resolved];
  const enabled = list.map((f, i) => [f, rlist[i]]).filter(([f]) => !(f && typeof f === "object" && f.enabled === false));
  if (!enabled.length) return null;
  const [f, rf] = enabled[0];
  const extra = enabled.length - 1;
  if (typeof f === "string") return { kind: "color", raw: f, resolved: typeof rf === "string" ? rf : undefined, extra };
  if (f?.type === "color") return { kind: "color", raw: f.color, resolved: typeof rf?.color === "string" ? rf.color : undefined, extra };
  return { kind: f?.type?.includes("gradient") ? "gradient" : f?.type ?? "unknown", extra };
}

function sizing(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return num(v);
  if (typeof v === "string" && v.startsWith("$")) return v;
  if (/^fill_container/.test(v)) return "fill";
  if (/^fit_content/.test(v)) return "hug";
  return String(v);
}

/** Every theme's value of a token, or the plain value. */
function value(model, raw, resolved) {
  if (raw === undefined || raw === null) return null;
  if (model.isToken(raw)) {
    const name = raw.slice(1);
    const vals = model.token(name);
    if (!vals) return `${raw}(${resolved !== undefined ? JSON.stringify(resolved) : "?"})`;
    const shown = vals.length === 1 ? String(vals[0].value) : vals.map((v) => `${v.value} ${v.theme ?? ""}`.trim()).join(", ");
    return `${raw}(${shown})`;
  }
  if (typeof raw === "object") return describeFill(raw);
  return num(raw);
}

/** A fill for display: the color with every theme's value, plus gradients, images and extra layers. */
function paint(model, raw, resolved) {
  const p = primaryFill(raw, resolved);
  if (!p) return null;
  const base = p.kind === "color" ? value(model, p.raw, p.resolved) : p.kind;
  return p.extra ? `${base} + ${p.extra} more fill${p.extra > 1 ? "s" : ""}` : base;
}

/** strokeWidth is a number or per side ({ bottom: 1 }). */
function strokeSides(w) {
  if (w === undefined || w === null) return "1";
  if (typeof w !== "object") return num(w);
  return Object.entries(w).map(([side, v]) => `${side} ${num(v)}`).join(", ");
}

function describeFill(f) {
  if (Array.isArray(f)) return f.map(describeFill).join(" + ");
  if (typeof f === "string") return f;
  if (f?.type === "color") return f.color ?? "color";
  if (f?.type === "image") return "image";
  if (f?.type?.includes("gradient")) return f.type.replace("_", " ");
  return f?.type ?? JSON.stringify(f);
}

function effects(e) {
  const list = Array.isArray(e) ? e : e ? [e] : [];
  return list.filter((x) => x.enabled !== false).map((x) => (x.type === "shadow" ? `shadow ${num(x.offset?.x ?? 0)},${num(x.offset?.y ?? 0)} blur ${num(x.blur ?? 0)} ${x.color ?? ""}`.trim() : x.type));
}

/** One outline line (without indentation). */
export function describe(model, n) {
  const parts = [`${n.name ?? n.id} [${n.type}${n.component ? ` ← ${n.component.name}` : ""}]`];
  parts.push(`${num(n.abs.w)}×${num(n.abs.h)} @${num(n.abs.x)},${num(n.abs.y)}`);
  const w = sizing(n.width), h = sizing(n.height);
  if (w || h) parts.push(`w:${w ?? "auto"} h:${h ?? "auto"}`);
  const lay = layoutOf(n);
  if (lay) {
    const bits = [lay === "vertical" ? "col" : lay === "horizontal" ? "row" : "absolute"];
    if (n.gap !== undefined) bits.push(`gap ${value(model, n.gap, n.resolved?.gap)}`);
    if (n.padding !== undefined) bits.push(`pad ${(Array.isArray(n.padding) ? n.padding : [n.padding]).map((v) => value(model, v)).join(" ")}`);
    if (n.justifyContent) bits.push(`justify ${n.justifyContent}`);
    if (n.alignItems) bits.push(`align ${n.alignItems}`);
    if (n.clip) bits.push("clip");
    parts.push(bits.join(" "));
  }
  if (n.layoutPosition === "absolute") parts.push("absolute");
  if (n.fill !== undefined && n.type !== "text" && n.type !== "icon") parts.push(`fill ${paint(model, n.fill, n.resolved?.fill)}`);
  if (n.cornerRadius !== undefined) parts.push(`radius ${Array.isArray(n.cornerRadius) ? n.cornerRadius.map((r) => value(model, r)).join(" ") : value(model, n.cornerRadius)}`);
  if (n.stroke !== undefined) parts.push(`stroke ${paint(model, n.stroke, n.resolved?.stroke)} ${strokeSides(n.resolved?.strokeWidth ?? n.strokeWidth)}`);
  for (const e of effects(n.effect)) parts.push(e);
  if (n.opacity !== undefined && n.opacity !== 1) parts.push(`opacity ${value(model, n.opacity)}`);
  if (n.type === "text") {
    const size = n.resolved?.fontSize ?? n.fontSize;
    const lh = n.resolved?.lineHeight ?? n.lineHeight;
    const weight = n.fontWeight !== undefined ? value(model, n.fontWeight, n.resolved?.fontWeight) : "";
    const font = [value(model, n.fontFamily), value(model, n.fontSize), weight, typeof lh === "number" && typeof size === "number" ? `lh ${num(size * lh)}px` : ""].filter(Boolean).join(" ");
    parts.push(`"${clip(n.resolved?.content ?? n.content)}" ${font}`);
    if (n.fill !== undefined) parts.push(`color ${paint(model, n.fill, n.resolved?.fill)}`);
    if (n.textGrowth) parts.push(`grow ${n.textGrowth}`);
  }
  if (n.type === "icon") parts.push(`icon ${n.library ?? ""}:${n.icon ?? ""} color ${paint(model, n.fill, n.resolved?.fill) ?? "none"}`);
  if (n.component?.overrides?.length) parts.push(`overrides ${n.component.overrides.length}`);
  if (n.clipped) parts.push(`⚠ ${n.clipped} clipped`);
  return parts.join(" · ");
}

/** Structure signature used to collapse repeated siblings (list rows, cards). */
function signature(n, depth = 3) {
  if (depth === 0) return n.type;
  return `${n.type}:${n.name}:${n.component?.id ?? ""}(${visibleChildren(n).map((c) => signature(c, depth - 1)).join(",")})`;
}

const texts = (n) => (n.type === "text" ? [clip(n.resolved?.content ?? n.content, 30)] : visibleChildren(n).flatMap(texts));

/** Groups consecutive siblings with the same structure (>= 3) as { node, count, variants }. */
export function collapse(children) {
  const out = [];
  for (let i = 0; i < children.length; ) {
    let j = i + 1;
    const sig = signature(children[i]);
    while (j < children.length && signature(children[j]) === sig) j++;
    const run = children.slice(i, j);
    if (run.length >= 3) out.push({ node: run[0], count: run.length, variants: run.map((r) => texts(r).join(" | ")) });
    else run.forEach((node) => out.push({ node, count: 1 }));
    i = j;
  }
  return out;
}

// Whole words only: "Subheader", "Unavailable" and "Product tabs" are content, not app shell.
const word = (alts) => new RegExp(`(^|[^\\p{L}\\p{N}])(${alts})([^\\p{L}\\p{N}]|$)`, "iu");
const SHELL_NAME = word("header|footer|nav|navbar|navigation|tab ?bar|tabbar|toolbar|app ?bar|bottom ?bar|status ?bar|sidebar|side ?bar|nav ?rail|điều hướng|thanh tab|đầu trang|chân trang");
// Words that mean shell only as the whole name ("Tabs", not "Product tabs").
const SHELL_ALONE = /^(tabs|menu|bar|top|bottom|chân|đầu)$/i;
const SCROLL_NAME = word("scroll|scroll ?view|content|body|main|cuộn|vùng cuộn|nội dung");
const NOT_CONTENT = new Set(["note", "prompt", "context"]);

/**
 * The screen's structure in reading order.
 * - App shell: children named like a header/footer/nav/tab bar/sidebar, or pinned (absolute, or in
 *   an absolute-layout screen) along a whole edge. Edges are top/bottom for vertical screens and
 *   left/right for horizontal ones.
 * - Scroll container: only in a vertical screen with a fixed height, a child whose height fills the
 *   screen (a name like "Content" breaks ties). It is expanded in place; the other sections then
 *   sit outside it and are marked fixed. Without one, nothing is marked fixed.
 * - Everything else is a section, in order. Nothing is dropped; notes are left to the outline.
 */
export function sections(model) {
  const root = model.root;
  const rootLayout = layoutOf(root) ?? "none";
  const top = visibleChildren(root).filter((c) => !NOT_CONTENT.has(c.type));
  const W = root.abs.w, H = root.abs.h;
  const edge = (c) => {
    if (rootLayout === "horizontal") return c.abs.x <= 4 ? "left" : c.abs.x + c.abs.w >= W - 4 ? "right" : null;
    return c.abs.y <= 4 ? "top" : c.abs.y + c.abs.h >= H - 4 ? "bottom" : null;
  };
  const pinned = (c) => {
    if (!(c.layoutPosition === "absolute" || rootLayout === "none")) return false;
    const e = edge(c) ?? (c.abs.x <= 4 ? "left" : c.abs.x + c.abs.w >= W - 4 ? "right" : null);
    if (e === "top" || e === "bottom") return c.abs.w >= 0.8 * W && c.abs.h <= 140;
    if (e === "left" || e === "right") return c.abs.h >= 0.8 * H && c.abs.w <= 360;
    return false;
  };
  // A name alone is not enough: "Section header" in the middle of a page is content. A named
  // shell must also be the first or last child, or touch an edge.
  const atEnd = (c) => c === top[0] || c === top.at(-1) || edge(c) !== null;
  const isShell = (c) => Boolean(pinned(c) || (atEnd(c) && (SHELL_NAME.test(c.name ?? "") || SHELL_ALONE.test((c.name ?? "").trim()))));
  const fixedHeight = typeof root.height === "number" || root.height === undefined;
  const candidates =
    rootLayout === "vertical" && fixedHeight
      ? top.filter((c) => !isShell(c) && /^fill_container/.test(String(c.height)) && visibleChildren(c).length)
      : [];
  const scroll = candidates.sort((a, b) => Number(SCROLL_NAME.test(b.name ?? "")) - Number(SCROLL_NAME.test(a.name ?? "")) || b.abs.h - a.abs.h)[0] ?? null;
  const items = (n) => {
    const out = [];
    const walk = (x) => {
      if (x.hidden || NOT_CONTENT.has(x.type)) return;
      if (x.component && x !== n) out.push(`<${x.component.name}>`);
      if (x.type === "text") out.push(`"${clip(x.resolved?.content ?? x.content, 40)}"`);
      else if (x.type === "icon") out.push(`icon:${x.icon}`);
      visibleChildren(x).forEach(walk);
    };
    walk(n);
    return out;
  };
  const shell = top.filter(isShell);
  const body = [];
  for (const c of top) {
    if (shell.includes(c)) continue;
    if (c === scroll) for (const k of visibleChildren(c).filter((k) => !NOT_CONTENT.has(k.type))) body.push({ node: k, items: items(k), fixed: false });
    else body.push({ node: c, items: items(c), fixed: Boolean(scroll) });
  }
  return {
    scroll,
    shell: shell.map((c) => ({ node: c, where: edge(c) ?? (pinned(c) ? "pinned" : "named"), items: items(c) })),
    sections: body,
  };
}

/** Sections with repeated siblings (list rows) collapsed, capped for output. */
export function sectionLines(sec, { max = 40 } = {}) {
  const lines = [];
  const groups = collapse(sec.sections.map((s) => s.node));
  const byNode = new Map(sec.sections.map((s) => [s.node, s]));
  let i = 0;
  for (const g of groups) {
    const s = byNode.get(g.node);
    i++;
    if (lines.length >= max) {
      lines.push(`… ${groups.length - i + 1} more sections: raise maxLines, or inspect the scroll container's id`);
      break;
    }
    const label = s.node.name ?? s.node.type;
    lines.push(`${i}. ${label} (${s.node.id})${s.fixed ? " (fixed)" : ""} — ${s.items.slice(0, 12).join(" ")}${s.items.length > 12 ? ` … +${s.items.length - 12}` : ""}`);
    if (g.count > 1) lines.push(`   ×${g.count - 1} more like ${label}`);
  }
  return lines;
}

// ---------------------------------------------------------------- code hints

const cssVar = (raw) => `var(${raw.slice(1).startsWith("--") ? raw.slice(1) : `--${raw.slice(1)}`})`;
const rnToken = (raw) => {
  const name = raw.slice(1).replace(/^--/, "");
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `T.${name}` : `T[${JSON.stringify(name)}]`;
};
const px = (v) => `${num(v)}px`;

function pads(p) {
  if (p === undefined || p === null || typeof p === "string") return null;
  const a = Array.isArray(p) ? p : [p];
  if (a.length === 1) return { t: a[0], r: a[0], b: a[0], l: a[0] };
  if (a.length === 2) return { t: a[0], r: a[1], b: a[0], l: a[1] };
  return { t: a[0], r: a[1], b: a[2], l: a[3] };
}

const JUSTIFY = { start: "start", center: "center", end: "end", space_between: "between", space_around: "around", space_evenly: "evenly" };
const ALIGN = { start: "start", center: "center", end: "end" };

/** Code hints for one node in the given flavor, following pen.dev's own tailwind.md rules. */
export function hint(model, n, parent, flavor) {
  if (!flavor) return null;
  const lay = layoutOf(n);
  const play = parent ? layoutOf(parent) : null;
  const colorOf = (raw, resolved) =>
    model.isToken(raw) ? { tw: `[${cssVar(raw)}]`, css: cssVar(raw), rn: rnToken(raw) } : typeof raw === "string" ? { tw: `[${raw}]`, css: raw, rn: JSON.stringify(raw) } : resolved ? { tw: `[${resolved}]`, css: resolved, rn: JSON.stringify(resolved) } : null;
  const w = sizing(n.width), h = sizing(n.height);
  const size = n.resolved?.fontSize ?? n.fontSize;
  const lh = n.resolved?.lineHeight ?? n.lineHeight;
  const p = pads(n.resolved?.padding ?? n.padding);
  const gap = n.resolved?.gap ?? n.gap;
  const radius = n.resolved?.cornerRadius ?? n.cornerRadius;
  const pf = primaryFill(n.fill, n.resolved?.fill);
  const fill = pf?.kind === "color" ? colorOf(pf.raw, pf.resolved) : null;
  const fillNote = pf && pf.kind !== "color" ? `${pf.kind} fill (see design)` : pf?.extra ? `+${pf.extra} more fills (see design)` : null;
  const weight = n.resolved?.fontWeight ?? n.fontWeight;
  const strokeWidth = n.resolved?.strokeWidth ?? n.strokeWidth;
  const stroke = primaryFill(n.stroke, n.resolved?.stroke);
  const shadow = effects(n.effect).find((e) => e.startsWith("shadow"));

  if (flavor === "tailwind") {
    const c = [];
    if (lay === "vertical") c.push("flex flex-col");
    else if (lay === "horizontal") c.push("flex");
    else if (lay === "none") c.push("relative");
    if (play === "none" || n.layoutPosition === "absolute") c.push(`absolute left-[${px(n.bounds?.x ?? 0)}] top-[${px(n.bounds?.y ?? 0)}]`);
    if (typeof gap === "number") c.push(`gap-[${px(gap)}]`);
    if (p) c.push(p.t === p.b && p.l === p.r ? (p.t === p.l ? `p-[${px(p.t)}]` : `py-[${px(p.t)}] px-[${px(p.l)}]`) : `pt-[${px(p.t)}] pr-[${px(p.r)}] pb-[${px(p.b)}] pl-[${px(p.l)}]`);
    if (JUSTIFY[n.justifyContent]) c.push(`justify-${JUSTIFY[n.justifyContent]}`);
    if (ALIGN[n.alignItems]) c.push(`items-${ALIGN[n.alignItems]}`);
    if (w === "fill") c.push(play === "horizontal" ? "flex-1" : "w-full");
    else if (w === "hug") c.push("w-fit");
    else if (w && w !== "auto" && !w.startsWith("$")) c.push(`w-[${px(Number(w))}]`);
    if (h === "fill") c.push(play === "vertical" ? "flex-1" : "h-full");
    else if (h === "hug") c.push("h-fit");
    else if (h && h !== "auto" && !h.startsWith("$") && n.type !== "text") c.push(`h-[${px(Number(h))}]`);
    if (fill && n.type !== "text" && n.type !== "icon") c.push(`bg-${fill.tw}`);
    if (typeof radius === "number") c.push(`rounded-[${px(radius)}]`);
    if (n.stroke !== undefined) {
      const s = (stroke?.kind === "color" ? colorOf(stroke.raw, stroke.resolved) : null);
      const sw = strokeWidth ?? 1;
      if (typeof sw === "object") for (const [side, v] of Object.entries(sw)) c.push(`border-${side[0]}-[${px(v)}]`);
      else c.push(sw === 1 ? "border" : `border-[${px(sw)}]`);
      if (s) c.push(`border-${s.tw}`);
    }
    if (n.clip) c.push("overflow-hidden");
    if (n.type === "text") {
      if (typeof size === "number") c.push(`text-[${px(size)}]`);
      if (typeof lh === "number" && typeof size === "number") c.push(`leading-[${px(size * lh)}]`);
      if (weight !== undefined) c.push(`font-[${weight === "normal" ? 400 : weight === "bold" ? 700 : weight}]`);
      if (fill) c.push(`text-${fill.tw}`);
      if (n.letterSpacing) c.push(`tracking-[${px(n.resolved?.letterSpacing ?? n.letterSpacing)}]`);
    }
    if (shadow) c.push("shadow-[…] (see effect)");
    if (fillNote) c.push(`/* ${fillNote} */`);
    return `tw: ${c.filter(Boolean).join(" ")}`;
  }

  if (flavor === "css") {
    const d = [];
    if (lay === "vertical" || lay === "horizontal") d.push("display:flex", `flex-direction:${lay === "vertical" ? "column" : "row"}`);
    if (play === "none" || n.layoutPosition === "absolute") d.push("position:absolute", `left:${px(n.bounds?.x ?? 0)}`, `top:${px(n.bounds?.y ?? 0)}`);
    if (typeof gap === "number") d.push(`gap:${px(gap)}`);
    if (p) d.push(`padding:${[p.t, p.r, p.b, p.l].map(px).join(" ")}`);
    if (n.justifyContent) d.push(`justify-content:${n.justifyContent.replace("space_", "space-").replace(/^(start|end)$/, "flex-$1")}`);
    if (n.alignItems) d.push(`align-items:${n.alignItems.replace(/^(start|end)$/, "flex-$1")}`);
    if (w === "fill") d.push(play === "horizontal" ? "flex:1" : "width:100%");
    else if (w === "hug") d.push("width:fit-content");
    else if (w && w !== "auto" && !w.startsWith("$")) d.push(`width:${px(Number(w))}`);
    if (h === "fill") d.push(play === "vertical" ? "flex:1" : "height:100%");
    else if (h && h !== "hug" && h !== "auto" && !h.startsWith("$") && n.type !== "text") d.push(`height:${px(Number(h))}`);
    if (fill && n.type !== "text" && n.type !== "icon") d.push(`background:${fill.css}`);
    if (typeof radius === "number") d.push(`border-radius:${px(radius)}`);
    if (n.stroke !== undefined) {
      const s = (stroke?.kind === "color" ? colorOf(stroke.raw, stroke.resolved) : null)?.css ?? "currentColor";
      const sw = strokeWidth ?? 1;
      if (typeof sw === "object") for (const [side, v] of Object.entries(sw)) d.push(`border-${side}:${px(v)} solid ${s}`);
      else d.push(`border:${px(sw)} solid ${s}`);
    }
    if (n.clip) d.push("overflow:hidden");
    if (n.type === "text") {
      if (typeof size === "number") d.push(`font-size:${px(size)}`);
      if (typeof lh === "number" && typeof size === "number") d.push(`line-height:${px(size * lh)}`);
      if (weight !== undefined) d.push(`font-weight:${weight}`);
      if (fill) d.push(`color:${fill.css}`);
    }
    d.push("box-sizing:border-box");
    if (fillNote) d.push(`/* ${fillNote} */`);
    return `css: ${d.join("; ")}`;
  }

  if (flavor === "react-native") {
    const s = [];
    if (lay === "vertical") s.push("flexDirection:'column'");
    else if (lay === "horizontal") s.push("flexDirection:'row'");
    if (play === "none" || n.layoutPosition === "absolute") s.push("position:'absolute'", `left:${num(n.bounds?.x ?? 0)}`, `top:${num(n.bounds?.y ?? 0)}`);
    if (typeof gap === "number") s.push(`gap:${num(gap)}`);
    if (p) s.push(p.t === p.b && p.l === p.r ? `paddingVertical:${num(p.t)}, paddingHorizontal:${num(p.l)}` : `paddingTop:${num(p.t)}, paddingRight:${num(p.r)}, paddingBottom:${num(p.b)}, paddingLeft:${num(p.l)}`);
    if (n.justifyContent) s.push(`justifyContent:'${n.justifyContent.replace("space_", "space-").replace(/^(start|end)$/, "flex-$1")}'`);
    if (n.alignItems) s.push(`alignItems:'${n.alignItems.replace(/^(start|end)$/, "flex-$1")}'`);
    if (w === "fill") s.push(play === "horizontal" ? "flex:1" : "alignSelf:'stretch'");
    else if (w && w !== "hug" && w !== "auto" && !w.startsWith("$")) s.push(`width:${w}`);
    if (h === "fill") s.push(play === "vertical" ? "flex:1" : "alignSelf:'stretch'");
    else if (h && h !== "hug" && h !== "auto" && !h.startsWith("$") && n.type !== "text") s.push(`height:${h}`);
    if (fill && n.type !== "text" && n.type !== "icon") s.push(`backgroundColor:${fill.rn}`);
    if (typeof radius === "number") s.push(`borderRadius:${num(radius)}`);
    if (n.stroke !== undefined) {
      const sw = strokeWidth ?? 1;
      const width = (v) => (v <= 0.5 ? "StyleSheet.hairlineWidth" : num(v));
      if (typeof sw === "object") for (const [side, v] of Object.entries(sw)) s.push(`border${side[0].toUpperCase()}${side.slice(1)}Width:${width(v)}`);
      else s.push(`borderWidth:${width(sw)}`);
      const c = (stroke?.kind === "color" ? colorOf(stroke.raw, stroke.resolved) : null);
      if (c) s.push(`borderColor:${c.rn}`);
    }
    if (n.clip) s.push("overflow:'hidden'");
    if (n.type === "text") {
      if (typeof size === "number") s.push(`fontSize:${num(size)}`);
      if (typeof lh === "number" && typeof size === "number") s.push(`lineHeight:${num(size * lh)}`);
      if (weight !== undefined) s.push(`fontWeight:'${weight === "normal" ? "400" : weight === "bold" ? "700" : weight}'`);
      if (fill) s.push(`color:${fill.rn}`);
      if (n.letterSpacing) s.push(`letterSpacing:${num(n.resolved?.letterSpacing ?? n.letterSpacing)}`);
      s.push("includeFontPadding:false");
    }
    if (shadow) s.push("shadow*: iOS shadowColor/Offset/Radius/Opacity + Android elevation (match visual weight)");
    if (fillNote) s.push(`/* ${fillNote} */`);
    return `rn: { ${s.join(", ")} }`;
  }
  return null;
}

// ---------------------------------------------------------------- outline

/**
 * The outline of a model: one line per visible node, repeated siblings collapsed, cut at `depth`
 * and `maxLines` with the follow-up call that continues from where it stopped.
 */
export function outline(model, { depth = 8, maxLines = 400, flavor, continueWith = (id) => id } = {}) {
  const { addresses: addr } = addresses(model);
  const lines = [];
  let truncatedAt = null;
  const push = (s) => {
    if (lines.length >= maxLines) return false;
    lines.push(s);
    return true;
  };
  const walk = (n, parent, level) => {
    if (truncatedAt) return;
    const pad = "  ".repeat(level);
    if (!push(`${pad}${describe(model, n)}`)) return (truncatedAt = n.id);
    const h = hint(model, n, parent, flavor);
    if (h && !push(`${pad}  ${h}`)) return (truncatedAt = n.id);
    const kids = visibleChildren(n);
    const hiddenCount = n.children.length - kids.length;
    if (!kids.length) return;
    if (level + 1 > depth) {
      const below = countBelow(n);
      push(`${pad}  … ${below} node${below === 1 ? "" : "s"} below: ${continueWith(n.id)}`);
      return;
    }
    for (const g of collapse(kids)) {
      walk(g.node, n, level + 1);
      if (truncatedAt) return;
      if (g.count > 1) {
        const differ = [...new Set(g.variants)].slice(1, 4).map((v) => `"${v}"`).join(", ");
        push(`${pad}  ×${g.count - 1} more like ${g.node.name ?? g.node.type}${differ ? ` (content: ${differ}${g.count > 4 ? ", …" : ""})` : ""}`);
      }
    }
    if (hiddenCount) push(`${pad}  (${hiddenCount} hidden)`);
  };
  walk(model.root, null, 0);
  if (truncatedAt) lines.push(`… output limit reached at ${addr.get(truncatedAt) ?? truncatedAt}: ${continueWith(truncatedAt)}`);
  if (model.skipped) lines.push(`… ${model.skipped} nodes past the read limit were not read: inspect a child node instead.`);
  return lines;
}

const countBelow = (n) => n.children.reduce((s, c) => s + 1 + countBelow(c), 0);

/** Plain JSON form of a model, for scripts (replaces hand-written measure scripts). */
export function toJson(model) {
  const { addresses: addr, duplicates } = addresses(model);
  const out = [];
  const walk = (n, parent) => {
    out.push({
      id: n.id,
      address: addr.get(n.id),
      parent: parent?.id ?? null,
      type: n.type,
      name: n.name ?? null,
      hidden: n.hidden || undefined,
      bounds: n.abs,
      width: n.width, height: n.height,
      layout: layoutOf(n) ?? undefined,
      gap: n.gap, padding: n.padding, justifyContent: n.justifyContent, alignItems: n.alignItems,
      fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth, cornerRadius: n.cornerRadius, effect: n.effect, opacity: n.opacity,
      text: n.type === "text" ? { content: n.resolved?.content ?? n.content, fontFamily: n.fontFamily, fontSize: n.fontSize, fontWeight: n.fontWeight, lineHeight: n.lineHeight, letterSpacing: n.letterSpacing } : undefined,
      icon: n.type === "icon" ? { library: n.library, icon: n.icon } : undefined,
      resolved: n.resolved,
      component: n.component ?? undefined,
      clipped: n.clipped,
    });
    for (const c of n.children) walk(c, n);
  };
  walk(model.root, null);
  return { nodes: out, duplicateNames: duplicates, variables: model.variables, themes: model.themes };
}
