// Design-file lint: checks one screen model for what makes designs hard to implement faithfully
// or to use (raw colors, off-scale values, contrast, touch targets, default names, hidden or
// clipped leftovers, near-misaligned siblings), with safe fixes where the answer is unambiguous.
import { parseColor, deltaE, toHex } from "../verify/color.js";
import { addresses } from "../design/model.js";

export const RULES = ["covered", "raw-color", "contrast", "touch-target", "default-name", "off-scale", "hidden-layer", "clipped", "misaligned", "uneven-spacing", "engine-problem"];

const DEFAULT_NAME = /^(frame|rectangle|ellipse|group|text|vector|line|path|polygon|star|image|component|instance|layer|shape|khung|nhóm|hình chữ nhật|văn bản)( ?\d+)?$/i;
// Matched word by word ("Tab indicator" is not a tab, "Fabric" is not a FAB).
const TAPPABLE = /^(button|btn|iconbutton|tab|toggle|switch|checkbox|radio|chip|link|fab|nút|cta|close|back)$/i;
const words = (name) =>
  String(name ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s/_\-·.:()]+/)
    .filter(Boolean);
const tappableName = (name) => words(name).some((w) => TAPPABLE.test(w)) || /icon ?button/i.test(name ?? "");
const NOT_CONTENT = new Set(["note", "prompt", "context"]);

const r1 = (v) => Math.round(v * 10) / 10;

function luminance({ r, g, b }) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** WCAG 2 contrast ratio. */
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const solid = (v) => {
  const c = parseColor(v);
  return c && c.a >= 0.999 ? c : null;
};
/**
 * What a fill paints: { color } for a solid color, { unknown: true } for gradients, images or
 * translucent colors (nothing reliable to measure against), null when it paints nothing.
 */
function paintOf(fill) {
  const list = Array.isArray(fill) ? fill : fill === undefined || fill === null ? [] : [fill];
  for (const f of list) {
    if (f && typeof f === "object" && f.enabled === false) continue;
    const c = typeof f === "string" ? parseColor(f) : f?.type === "color" ? parseColor(f.color) : null;
    if (c && c.a <= 0.01) continue; // transparent: paints nothing
    if (c && c.a >= 0.999) return { color: c };
    return { unknown: true };
  }
  return null;
}
const fillColor = (fill) => paintOf(fill)?.color ?? null;
const overlaps = (a, b) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);

/** Color variables and their value in `theme` (or their only value). */
export function colorTokens(variables, theme) {
  const out = [];
  for (const [name, v] of Object.entries(variables ?? {})) {
    if (v?.type !== "color") continue;
    const vals = Array.isArray(v.value) ? v.value : [{ value: v.value }];
    const pick = vals.find((e) => e.theme && theme && Object.values(e.theme).includes(theme)) ?? vals.find((e) => !e.theme) ?? vals[0];
    const c = parseColor(pick?.value);
    if (c) out.push({ name, color: c, themed: vals.length > 1 });
  }
  return out;
}

/**
 * Findings for one screen model: [{ rule, severity, id, address, message, fix? }], where fix is
 * { props } to Update the node with. `doc` carries document-wide context: { variables, rareFontSizes,
 * rareSpacing, mobile }.
 */
export function lintScreen(model, doc = {}) {
  const { addresses: addr } = addresses(model);
  const theme = model.root.theme && typeof model.root.theme === "object" ? Object.values(model.root.theme)[0] : null;
  const tokens = colorTokens(doc.variables ?? model.variables, theme);
  const findings = [];
  const add = (rule, severity, n, message, fix) => findings.push({ rule, severity, id: n.id, address: addr.get(n.id) ?? n.name, message, fix });
  const mobile = doc.mobile ?? model.root.abs.w <= 480;
  const byId = model.nodes;
  const parentOf = (n) => (n.parent ? byId.get(n.parent) : null);

  // What a text sits on: layers below it that it overlaps (earlier siblings of it and of its
  // ancestors), then its ancestors' fills. Images, gradients and translucent layers make it
  // unknown (null): contrast is then not judged.
  const translucent = (x) => {
    const o = Number(x.resolved?.opacity ?? x.opacity);
    return Number.isFinite(o) && o < 1;
  };
  // The topmost painted layer inside `x`'s subtree (x included) under `box`, in paint order:
  // { color }, { unknown } (image, gradient, translucent), or null when nothing there paints.
  const topPaint = (x, box) => {
    if (x.hidden || !overlaps(x.abs, box)) return null;
    for (const c of [...x.children].reverse()) {
      const hit = topPaint(c, box);
      if (hit) return hit;
    }
    if (x.type === "image" || x.type === "icon") return x.type === "image" ? { unknown: true } : null;
    if (x.type === "text") return null;
    const paint = paintOf(x.resolved?.fill ?? x.fill);
    if (paint && translucent(x)) return { unknown: true };
    return paint;
  };
  const backdrop = (n) => {
    if (translucent(n)) return null;
    for (let cur = n, p = parentOf(n); p; cur = p, p = parentOf(p)) {
      if (translucent(p)) return null;
      const below = p.children.slice(0, p.children.indexOf(cur)).reverse();
      for (const sib of below) {
        const paint = topPaint(sib, n.abs);
        if (paint?.unknown) return null;
        if (paint?.color) return paint.color;
      }
      const paint = paintOf(p.resolved?.fill ?? p.fill);
      if (paint?.unknown) return null;
      if (paint?.color) return paint.color;
      if (p === model.root) break;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  // The first opaque layer painted after n (later siblings of n and of its ancestors) covering most of it.
  // n's box as far as clipping ancestors let it show.
  const visibleBox = (n) => {
    let { x, y, w, h } = n.abs;
    for (let p = parentOf(n); p; p = parentOf(p)) {
      if (!p.clip) continue;
      const c = p.abs;
      const x2 = Math.min(x + w, c.x + c.w), y2 = Math.min(y + h, c.y + c.h);
      x = Math.max(x, c.x);
      y = Math.max(y, c.y);
      w = Math.max(0, x2 - x);
      h = Math.max(0, y2 - y);
    }
    return { x, y, w, h };
  };
  const coveredBy = (n) => {
    // Only the part that shows can be covered: text below a scroll fold is hidden by the clip.
    const v = visibleBox(n);
    const area = v.w * v.h;
    if (!area) return null;
    for (let cur = n, p = parentOf(n); p; cur = p, p = parentOf(p)) {
      for (const sib of p.children.slice(p.children.indexOf(cur) + 1)) {
        if (sib.hidden || NOT_CONTENT.has(sib.type) || sib.type === "text") continue;
        const paint = paintOf(sib.resolved?.fill ?? sib.fill);
        if (!paint?.color || translucent(sib)) continue;
        const w = Math.min(v.x + v.w, sib.abs.x + sib.abs.w) - Math.max(v.x, sib.abs.x);
        const h = Math.min(v.y + v.h, sib.abs.y + sib.abs.h) - Math.max(v.y, sib.abs.y);
        if (w > 0 && h > 0 && (w * h) / area >= 0.5) return sib;
      }
      if (p === model.root) break;
    }
    return null;
  };
  const clipAncestor = (n) => {
    for (let p = parentOf(n); p; p = parentOf(p)) if (p.clip) return p;
    return null;
  };
  // Below the fold of a clipping container (a scroll area): not a leftover.
  const isScrollContent = (n) => {
    const c = clipAncestor(n)?.abs;
    return Boolean(c) && n.abs.x < c.x + c.w && n.abs.x + n.abs.w > c.x && (n.abs.y >= c.y + c.h - 0.5 || n.abs.x >= c.x + c.w - 0.5);
  };

  // Raw colors where a token exists (the root too: a screen's background, a component's fill).
  const checkColors = (n, own, instance) => {
    for (const prop of ["fill", "stroke"]) {
      const raw = n[prop];
      // An instance shows its component's colors: fix them on the component (checked separately).
      if (!own || instance || typeof raw !== "string" || raw.startsWith("$")) continue;
      const c = parseColor(raw);
      if (!c || c.a <= 0.01) continue; // transparent paints nothing; no token needed
      if (c.a < 0.999) {
        // Translucent: only an exact match (alpha included) is the same color.
        const same = tokens.filter((t) => toHex(t.color) === toHex(c));
        if (same.length === 1 && !same[0].themed) add("raw-color", "medium", n, `${prop} ${toHex(c)} is the value of $${same[0].name}; use the token.`, { props: { [prop]: `$${same[0].name}` } });
        continue;
      }
      const exact = tokens.filter((t) => !t.themed && toHex(t.color) === toHex(c));
      const near = tokens.map((t) => ({ t, d: deltaE(t.color, c) })).sort((a, b) => a.d - b.d)[0];
      if (exact.length === 1) add("raw-color", "medium", n, `${prop} ${toHex(c)} is the value of $${exact[0].name}; use the token.`, { props: { [prop]: `$${exact[0].name}` } });
      else if (exact.length > 1) add("raw-color", "medium", n, `${prop} ${toHex(c)} is the value of ${exact.map((t) => `$${t.name}`).join(", ")}; use the one that means this.`);
      else if (near && near.d < 0.5 && near.t.themed)
        add("raw-color", "low", n, `${prop} ${toHex(c)} equals $${near.t.name} in this theme, but that token changes with the theme; use it if this color should follow the theme, or add a fixed token if it should not.`);
      else if (near && near.d < 3) add("raw-color", "medium", n, `${prop} ${toHex(c)} is almost $${near.t.name} (${toHex(near.t.color)}, ΔE ${r1(near.d)}); use the token if that is what it means.`);
      else if (tokens.length) add("raw-color", "low", n, `${prop} ${toHex(c)} matches no color token; add a token or use an existing one.`);
    }

  };

  const walk = (n, hiddenAbove, inInstance) => {
    if (NOT_CONTENT.has(n.type)) return;
    const hidden = hiddenAbove || n.hidden;
    const instance = Boolean(n.component) && !inInstance;
    const own = !inInstance; // inside an instance, fix the component instead
    if (n === model.root && !n.hidden) checkColors(n, true, false);
    if (n !== model.root && !hiddenAbove) {
      if (n.hidden && own) add("hidden-layer", "low", n, `hidden layer "${n.name ?? n.type}" left in the screen — delete it or show it; implementers cannot tell whether it belongs.`);

      if (!hidden) {
        checkColors(n, own, instance);

        // Text contrast against what it sits on (WCAG AA).
        if (n.type === "text" && String(n.resolved?.content ?? n.content ?? "").trim()) {
          const fg = fillColor(n.resolved?.fill ?? n.fill);
          const size = Number(n.resolved?.fontSize ?? n.fontSize) || 14;
          const weight = Number(n.resolved?.fontWeight ?? n.fontWeight) || 400;
          // Over images, gradients or translucent layers the color behind is measured on the render.
          let bg = fg && fg.a >= 0.999 ? backdrop(n) : null;
          const measured = fg && fg.a >= 0.999 && !bg && doc.sampleBg ? doc.sampleBg(n.abs) : null;
          bg ??= measured;
          if (bg) {
            const ratio = contrast(fg, bg);
            const large = size >= 24 || (size >= 18.66 && weight >= 700);
            const need = large ? 3 : 4.5;
            if (ratio < need) add("contrast", ratio < need - 1.5 ? "high" : "medium", n, `contrast ${r1(ratio)}:1 for ${size}px text (${toHex(fg)} on ${toHex(bg)}${measured ? ", measured on the render over an image or gradient" : ""}); WCAG AA needs ${need}:1.`);
          }
        }

        // A text painted over by a later opaque layer (a sibling of it or of an ancestor).
        if (n.type === "text" && String(n.resolved?.content ?? n.content ?? "").trim()) {
          const cover = coveredBy(n);
          if (cover) add("covered", "high", n, `"${String(n.resolved?.content ?? n.content).slice(0, 40)}" is hidden under "${cover.name ?? cover.type}", painted after it; move the text above it or the layer below.`);
        }

        // Touch targets on phone screens.
        const label = `${n.name ?? ""} ${n.component?.name ?? ""}`;
        const bigTappableAbove = (() => {
          for (let p = parentOf(n); p && p !== model.root; p = parentOf(p)) if (tappableName(`${p.name ?? ""} ${p.component?.name ?? ""}`) && p.abs.w >= 44 && p.abs.h >= 44) return true;
          return false;
        })();
        if (mobile && (instance || n.type === "frame") && own && tappableName(label) && (n.abs.w < 44 || n.abs.h < 44) && Math.min(n.abs.w, n.abs.h) > 4 && !bigTappableAbove) {
          add("touch-target", "medium", n, `"${n.name}" is ${r1(n.abs.w)}×${r1(n.abs.h)}; tappable things need 44×44 (Apple) / 48×48 (Material) — enlarge it or its hit area.`);
        }

        // Default names say nothing to the implementer or to verify's markers.
        if (own && n.name && DEFAULT_NAME.test(n.name.trim())) {
          const text = n.type === "text" ? String(n.resolved?.content ?? n.content ?? "").trim() : null;
          const onlyText = !text && n.children.length === 1 && n.children[0].type === "text" ? String(n.children[0].resolved?.content ?? n.children[0].content ?? "").trim() : null;
          // "/" separates layer addresses (verify markers): never put it in a name.
          const proposal = (instance ? n.component?.name : (text ?? onlyText)?.replace(/\s+/g, " ").slice(0, 40))?.replace(/\s*\/\s*/g, " – ");
          add("default-name", "low", n, `default name "${n.name}"${proposal ? `; rename to "${proposal}"` : " — name it for what it is"}.`, proposal ? { props: { name: proposal } } : undefined);
        }

        // Off-scale values: sizes and spacing used almost nowhere else in the document.
        if (own && n.type === "text" && typeof n.fontSize === "number" && doc.rareFontSizes?.has(n.fontSize)) {
          add("off-scale", "low", n, `font size ${n.fontSize} is used ≤2 times in the document; use a size from the type scale.`);
        }
        if (own) {
          const pads = n.padding === undefined ? [] : [].concat(n.padding).filter((v) => typeof v === "number");
          const odd = [...(typeof n.gap === "number" ? [n.gap] : []), ...pads].filter((v) => doc.rareSpacing?.has(v) && v % 2 !== 0);
          if (odd.length) add("off-scale", "low", n, `spacing ${[...new Set(odd)].join(", ")} is off the spacing scale (rare and odd); snap to the scale.`);
        }

        // Cut off by its clipping container, except where that is the point: content running past the
        // bottom of a scroll area, or the next items of a horizontal carousel.
        if (n.clipped === "partially" && (n.type === "text" || instance)) {
          const clip = clipAncestor(n);
          const c = clip?.abs;
          const past = c && {
            top: n.abs.y < c.y - 0.5, left: n.abs.x < c.x - 0.5,
            bottom: n.abs.y + n.abs.h > c.y + c.h + 0.5, right: n.abs.x + n.abs.w > c.x + c.w + 0.5,
          };
          // A scroll area or carousel: the screen itself, or a container where several children run
          // past the same edge. A lone text cut by a small box is a real cut.
          const axis = past && (past.bottom && !past.right ? "y" : past.right && !past.bottom ? "x" : null);
          const runners = axis ? clip.children.filter((k) => !k.hidden && (axis === "y" ? k.abs.y + k.abs.h > c.y + c.h + 0.5 : k.abs.x + k.abs.w > c.x + c.w + 0.5)).length : 0;
          const scrolls = past && !past.top && !past.left && axis && (clip === model.root || runners >= 2 || (clip.layout === (axis === "y" ? "vertical" : "horizontal") && clip.children.length >= 3));
          if (!scrolls) add("clipped", "medium", n, `"${n.name ?? n.type}" is partly cut off by "${clip?.name ?? "its container"}"; the implementation cannot match a cut-off design.`);
        } else if (n.clipped === "fully" && own && !isScrollContent(n)) add("clipped", "low", n, `"${n.name ?? n.type}" lies entirely outside its clipping container (invisible) — move or delete it.`);

        const problems = [].concat(n.problems ?? []).map((p) => (typeof p === "string" ? p : p?.message ?? JSON.stringify(p))).filter((p) => !/clipped/i.test(p)); // clipping is judged above
        if (problems.length && own) add("engine-problem", "medium", n, `pen.dev reports: ${problems.join("; ").slice(0, 200)}`);
      }
    }

    // Siblings placed by hand: near-misses in alignment and spacing.
    const free = n.type === "group" || (n.type === "frame" && n.layout === "none");
    if (free && !hidden && !inInstance) {
      const kids = n.children.filter((c) => !c.hidden && !NOT_CONTENT.has(c.type) && c.abs.w > 0);
      // Left edges: a child 1-3px off an edge that more siblings share is misaligned (once).
      const edges = new Map();
      for (const k of kids) edges.set(r1(k.abs.x), (edges.get(r1(k.abs.x)) ?? 0) + 1);
      for (const k of kids) {
        const x = r1(k.abs.x);
        const near = [...edges].filter(([e, count]) => e !== x && Math.abs(e - x) <= 3 && count > edges.get(x)).sort((a, b) => b[1] - a[1])[0];
        if (!near) continue;
        const partner = kids.find((o) => r1(o.abs.x) === near[0]);
        const centered = kids.some((o) => r1(o.abs.x) === near[0] && Math.abs(o.abs.x + o.abs.w / 2 - (k.abs.x + k.abs.w / 2)) <= 0.5);
        if (!centered) add("misaligned", "low", k, `left edge ${x} vs ${near[0]} shared by ${near[1]} siblings (e.g. "${partner?.name ?? partner?.type}") — ${r1(Math.abs(near[0] - x))}px off; align them.`);
      }
      const column = [...kids].sort((a, b) => a.abs.y - b.abs.y);
      const gaps = column.slice(1).map((c, k) => r1(c.abs.y - (column[k].abs.y + column[k].abs.h))).filter((g) => g >= 0);
      if (gaps.length >= 3) {
        const counts = new Map();
        for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
        const [common, times] = [...counts].sort((a, b) => b[1] - a[1])[0];
        const off = gaps.filter((g) => g !== common && Math.abs(g - common) <= 3);
        if (times >= 2 && off.length) add("uneven-spacing", "low", n, `stacked children are ${common}px apart except ${[...new Set(off)].join(", ")}px; make the spacing even (or use auto layout).`);
      }
    }
    for (const c of n.children) walk(c, hidden, inInstance || instance);
  };
  walk(model.root, false, false);
  return findings;
}

/**
 * Document-level findings from the overview analysis: screens missing a theme or width that most
 * screens of the same kind have.
 */
export function lintVariants(analysis) {
  const out = [];
  const rows = analysis.matrix?.rows ?? [];
  // A frame without a theme shows the document's first (base) theme.
  const base = Object.values(analysis.themes ?? {})[0]?.[0] ?? null;
  const themesOf = (r) => new Set(Object.values(r.cells).flat().map((c) => c.theme ?? base).filter(Boolean));
  const allThemes = new Map();
  for (const r of rows) for (const t of themesOf(r)) allThemes.set(t, (allThemes.get(t) ?? 0) + 1);
  for (const [t, n] of allThemes) {
    if (n < rows.length / 2 || n === rows.length) continue;
    for (const r of rows) {
      if (!themesOf(r).has(t)) out.push({ rule: "variants", severity: "low", id: Object.values(r.cells).flat()[0]?.id, address: `${r.screen}${r.state ? ` — ${r.state}` : ""}`, message: `no ${t} frame, which ${n} of ${rows.length} screens have.` });
    }
  }
  return out;
}
