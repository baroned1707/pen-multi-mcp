// Formats a design model for agents: an outline (one line per node), the screen's sections and
// shell, per-node code hints (Tailwind, CSS, React Native), and a JSON form for scripts.
import { addresses } from "./model.js";

const num = (v) => (typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v));
const clip = (s, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const visibleChildren = (n) => n.children.filter((c) => !c.hidden);
/** Frames without a layout property lay out as a horizontal row; `none` means absolute. */
const layoutOf = (n) => (n.type !== "frame" ? null : n.layout ?? "horizontal");

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
  if (n.fill !== undefined && n.type !== "text" && n.type !== "icon") parts.push(`fill ${value(model, n.fill, n.resolved?.fill)}`);
  if (n.cornerRadius !== undefined) parts.push(`radius ${Array.isArray(n.cornerRadius) ? n.cornerRadius.map((r) => value(model, r)).join(" ") : value(model, n.cornerRadius)}`);
  if (n.stroke !== undefined) parts.push(`stroke ${value(model, n.stroke, n.resolved?.stroke)} ${strokeSides(n.strokeWidth)}`);
  for (const e of effects(n.effect)) parts.push(e);
  if (n.opacity !== undefined && n.opacity !== 1) parts.push(`opacity ${value(model, n.opacity)}`);
  if (n.type === "text") {
    const size = n.resolved?.fontSize ?? n.fontSize;
    const lh = n.resolved?.lineHeight ?? n.lineHeight;
    const font = [value(model, n.fontFamily), value(model, n.fontSize), n.fontWeight ?? "", lh !== undefined && typeof size === "number" ? `lh ${num(size * lh)}px` : ""].filter(Boolean).join(" ");
    parts.push(`"${clip(n.resolved?.content ?? n.content)}" ${font}`);
    if (n.fill !== undefined) parts.push(`color ${value(model, n.fill, n.resolved?.fill)}`);
    if (n.textGrowth) parts.push(`grow ${n.textGrowth}`);
  }
  if (n.type === "icon") parts.push(`icon ${n.library ?? ""}:${n.icon ?? ""} color ${value(model, n.fill, n.resolved?.fill) ?? "none"}`);
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

const SHELL_NAME = /header|nav|tab ?bar|tabs|toolbar|app ?bar|bottom ?bar|status ?bar|điều hướng|thanh (điều hướng|tab|trên|dưới)|đầu trang|chân trang/i;
const SCROLL_NAME = /scroll|content|body|main|cuộn|nội dung|thân/i;

/**
 * The screen's sections in order, and which children look like app shell (docked header, tab bar).
 * If the screen has a main scroll container, its children are the sections.
 */
export function sections(model) {
  const root = model.root;
  const top = visibleChildren(root);
  const isShell = (c) =>
    (c.abs.y <= 4 && c.abs.h <= 140) || (c.abs.y + c.abs.h >= root.abs.h - 4 && c.abs.h <= 140) || SHELL_NAME.test(c.name ?? "");
  const scroll = top
    .filter((c) => layoutOf(c) === "vertical" && (/^fill_container/.test(String(c.height)) || SCROLL_NAME.test(c.name ?? "")) && !isShell(c))
    .sort((a, b) => b.abs.h - a.abs.h)[0];
  const items = (n) => {
    const out = [];
    const walk = (x) => {
      if (x.hidden) return;
      if (x.component && x !== n) out.push(`<${x.component.name}>`);
      if (x.type === "text") out.push(`"${clip(x.resolved?.content ?? x.content, 40)}"`);
      else if (x.type === "icon") out.push(`icon:${x.icon}`);
      visibleChildren(x).forEach(walk);
    };
    walk(n);
    return out;
  };
  const shell = top.filter((c) => c !== scroll && isShell(c));
  const body = scroll ? visibleChildren(scroll) : top.filter((c) => !shell.includes(c));
  return {
    scroll: scroll ?? null,
    shell: shell.map((c) => ({ node: c, where: c.abs.y <= 4 ? "top" : c.abs.y + c.abs.h >= root.abs.h - 4 ? "bottom" : "named", items: items(c) })),
    sections: body.map((c) => ({ node: c, items: items(c) })),
  };
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
  const fill = n.fill !== undefined ? colorOf(n.fill, n.resolved?.fill) : null;
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
      const s = colorOf(n.stroke, n.resolved?.stroke);
      const sw = n.strokeWidth ?? 1;
      if (typeof sw === "object") for (const [side, v] of Object.entries(sw)) c.push(`border-${side[0]}-[${px(v)}]`);
      else c.push(sw === 1 ? "border" : `border-[${px(sw)}]`);
      if (s) c.push(`border-${s.tw}`);
    }
    if (n.clip) c.push("overflow-hidden");
    if (n.type === "text") {
      if (typeof size === "number") c.push(`text-[${px(size)}]`);
      if (typeof lh === "number" && typeof size === "number") c.push(`leading-[${px(size * lh)}]`);
      if (n.fontWeight) c.push(`font-[${n.fontWeight === "normal" ? 400 : n.fontWeight === "bold" ? 700 : n.fontWeight}]`);
      if (fill) c.push(`text-${fill.tw}`);
      if (n.letterSpacing) c.push(`tracking-[${px(n.resolved?.letterSpacing ?? n.letterSpacing)}]`);
    }
    if (shadow) c.push("shadow-[…] (see effect)");
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
      const s = colorOf(n.stroke, n.resolved?.stroke)?.css ?? "currentColor";
      const sw = n.strokeWidth ?? 1;
      if (typeof sw === "object") for (const [side, v] of Object.entries(sw)) d.push(`border-${side}:${px(v)} solid ${s}`);
      else d.push(`border:${px(sw)} solid ${s}`);
    }
    if (n.clip) d.push("overflow:hidden");
    if (n.type === "text") {
      if (typeof size === "number") d.push(`font-size:${px(size)}`);
      if (typeof lh === "number" && typeof size === "number") d.push(`line-height:${px(size * lh)}`);
      if (n.fontWeight) d.push(`font-weight:${n.fontWeight}`);
      if (fill) d.push(`color:${fill.css}`);
    }
    d.push("box-sizing:border-box");
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
      const sw = n.strokeWidth ?? 1;
      const width = (v) => (v <= 0.5 ? "StyleSheet.hairlineWidth" : num(v));
      if (typeof sw === "object") for (const [side, v] of Object.entries(sw)) s.push(`border${side[0].toUpperCase()}${side.slice(1)}Width:${width(v)}`);
      else s.push(`borderWidth:${width(sw)}`);
      const c = colorOf(n.stroke, n.resolved?.stroke);
      if (c) s.push(`borderColor:${c.rn}`);
    }
    if (n.clip) s.push("overflow:'hidden'");
    if (n.type === "text") {
      if (typeof size === "number") s.push(`fontSize:${num(size)}`);
      if (typeof lh === "number" && typeof size === "number") s.push(`lineHeight:${num(size * lh)}`);
      if (n.fontWeight) s.push(`fontWeight:'${n.fontWeight === "normal" ? "400" : n.fontWeight === "bold" ? "700" : n.fontWeight}'`);
      if (fill) s.push(`color:${fill.rn}`);
      if (n.letterSpacing) s.push(`letterSpacing:${num(n.resolved?.letterSpacing ?? n.letterSpacing)}`);
      s.push("includeFontPadding:false");
    }
    if (shadow) s.push("shadow*: iOS shadowColor/Offset/Radius/Opacity + Android elevation (match visual weight)");
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
