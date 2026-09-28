// The design side of a verification: the nodes of one screen worth comparing, with values already
// resolved in the screen's theme, and the order of its sections.
import { addresses } from "../design/model.js";
import { primaryFill, sections } from "../design/inspect.js";
import { parseColor } from "./color.js";

const NOT_CONTENT = new Set(["note", "prompt", "context"]);
// Phone chrome drawn into mockups: the OS renders it, the app never does.
const DEVICE_CHROME = /^(status ?bar|home ?indicator|notch|dynamic ?island|system ?bar|navigation ?bar \(system\)|thanh trạng thái|ios status bar|android status bar)$/i;
const SHAPES = new Set(["frame", "rectangle", "ellipse", "group"]);

const numberOf = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return Number(v);
  return undefined;
};
const WEIGHTS = { thin: 100, extralight: 200, light: 300, normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
export const weightOf = (v) => numberOf(v) ?? WEIGHTS[String(v ?? "").toLowerCase().replace(/[\s_-]/g, "")];

/** The solid color a fill paints, resolved in the node's theme, or null (none, gradient, image, token without value). */
export function colorOf(raw, resolved) {
  const p = primaryFill(raw, resolved);
  if (!p || p.kind !== "color") return null;
  const c = parseColor(p.resolved ?? p.raw);
  return c && c.a > 0 ? c : null;
}

const strokeWidthOf = (w) => {
  if (w === undefined || w === null) return 1;
  if (typeof w === "number") return w;
  if (typeof w === "object") return Math.max(0, ...Object.values(w).map(Number).filter(Number.isFinite));
  return numberOf(w) ?? 1;
};

/**
 * Compared nodes of a screen model: texts, component instances, icons, painted shapes, and the
 * screen's sections and shell. Hidden subtrees, fully clipped nodes and annotations are left out;
 * inside an instance only texts are compared (the instance box covers the rest).
 */
export function designNodes(model) {
  const { addresses: addr } = addresses(model);
  const sec = sections(model);
  const sectionIds = new Map();
  for (const s of sec.shell) sectionIds.set(s.node.id, "shell");
  for (const s of sec.sections) sectionIds.set(s.node.id, "section");
  const out = [];
  const chrome = [];
  // `anc`: compared ancestors, nearest first (for relative positions and container matching).
  const walk = (n, insideInstance, anc) => {
    if (n.hidden || NOT_CONTENT.has(n.type)) return;
    if (n !== model.root && DEVICE_CHROME.test(String(n.name ?? "").trim())) {
      chrome.push({ name: n.name, box: { ...n.abs } });
      return;
    }
    const r = n.resolved ?? {};
    const opacity = numberOf(r.opacity ?? n.opacity);
    if (opacity === 0) return;
    const instance = Boolean(n.component) && !insideInstance;
    let kept = null;
    if (n !== model.root && n.clipped !== "fully" && n.abs.w > 0 && n.abs.h > 0) {
      let kind = null;
      if (n.type === "text" && String(r.content ?? n.content ?? "").trim()) kind = "text";
      else if (sectionIds.has(n.id)) kind = sectionIds.get(n.id);
      else if (!insideInstance && instance) kind = "instance";
      else if (!insideInstance && n.type === "icon") kind = "icon";
      else if (!insideInstance && SHAPES.has(n.type) && (colorOf(n.fill, r.fill) || (n.stroke !== undefined && colorOf(n.stroke, r.stroke)))) kind = "box";
      if (kind) {
        const size = numberOf(r.fontSize ?? n.fontSize);
        const lh = numberOf(r.lineHeight ?? n.lineHeight);
        const radius = r.cornerRadius ?? n.cornerRadius;
        out.push({
          id: n.id,
          kind,
          name: n.name ?? n.type,
          type: n.type,
          address: addr.get(n.id),
          component: n.component?.name,
          box: { ...n.abs },
          text: kind === "text" ? String(r.content ?? n.content) : undefined,
          fixedWidth: kind === "text" ? /^fixed/.test(n.textGrowth ?? "") : undefined,
          align: kind === "text" ? (r.textAlign ?? n.textAlign ?? "left") : undefined,
          // A text's and an icon's fill is the color of its glyphs, not a background.
          fill: kind === "text" || n.type === "icon" ? undefined : colorOf(n.fill, r.fill),
          color: kind === "text" || n.type === "icon" ? colorOf(n.fill, r.fill) : undefined,
          fontSize: kind === "text" ? size : undefined,
          fontWeight: kind === "text" ? (weightOf(r.fontWeight ?? n.fontWeight) ?? 400) : undefined, // unset is normal
          lineHeight: kind === "text" && size && lh ? size * lh : undefined,
          radius: numberOf(Array.isArray(radius) ? radius[0] : radius),
          stroke: n.stroke !== undefined ? colorOf(n.stroke, r.stroke) : undefined,
          strokeWidth: n.stroke !== undefined ? strokeWidthOf(r.strokeWidth ?? n.strokeWidth) : undefined,
          insideInstance,
          ancestors: anc,
        });
        kept = n.id;
      }
    }
    for (const c of n.children) walk(c, insideInstance || instance, kept ? [kept, ...anc] : anc);
  };
  walk(model.root, false, []);
  return {
    nodes: out,
    frame: { id: model.root.id, name: model.root.name, w: model.root.abs.w, h: model.root.abs.h },
    deviceChrome: chrome,
    order: sec.sections.filter((s) => !s.fixed).map((s) => s.node.id),
    allNames: new Set([...model.nodes.values()].map((n) => n.name).filter(Boolean)),
    addressOf: (id) => addr.get(id),
    nodeIds: new Set(model.nodes.keys()),
    addresses: addr,
  };
}
