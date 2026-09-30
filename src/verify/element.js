// One element of a capture as its own snapshot: for verifying a component (or a component state
// frame such as "Button — hover") against the element that implements it.
import { crop } from "./image.js";

const inside = (b, e) => {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return cx >= e.x - 0.5 && cx <= e.x + e.w + 0.5 && cy >= e.y - 0.5 && cy <= e.y + e.h + 0.5;
};
const shift = (b, e) => (b ? { ...b, x: b.x - e.x, y: b.y - e.y } : b);
const same = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;

/**
 * The snapshot cut to `snapshot.element` (a page box): the elements whose center lies inside it,
 * moved to its origin, without the element itself (it is the frame: its background becomes the
 * page background, as a design frame's fill is). Returns the snapshot unchanged without an element.
 */
export function cropSnapshot(snapshot) {
  const e = snapshot.element?.box;
  if (!e) return snapshot;
  const kept = snapshot.elements.filter((el) => el.box && inside(el.box, e));
  // The element itself: the outermost kept element with the element's box.
  const self = kept.find((el) => same(el.box, e));
  const ids = new Set(kept.filter((el) => el !== self).map((el) => el.i));
  const elements = kept
    .filter((el) => el !== self)
    .map((el) => ({ ...el, parent: ids.has(el.parent) ? el.parent : undefined, box: shift(el.box, e), textBox: shift(el.textBox, e), contentBox: shift(el.contentBox, e) }));
  const opaque = (c) => c && !/^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/.test(c);
  return {
    ...snapshot,
    viewport: { ...snapshot.viewport, w: e.w, h: e.h },
    pageBg: opaque(snapshot.element.bg) ? snapshot.element.bg : snapshot.pageBg,
    elements,
    page: { viewport: snapshot.viewport, pageBg: snapshot.pageBg, elements: snapshot.elements.length },
  };
}

/** The element's region of the page screenshot (page and screenshot are in the same pixels). */
export function cropImage(img, snapshot) {
  const e = snapshot.element?.box;
  if (!img || !e) return img;
  const k = img.width / (snapshot.viewport?.w ?? img.width);
  return crop(img, { x: e.x * k, y: e.y * k, w: e.w * k, h: e.h * k });
}

// A component state frame's state, as the web step that shows it.
const STATE_STEP = { hover: "hover", hovered: "hover", focus: "focus", focused: "focus", "focus-visible": "focus", pressed: "down", press: "down", active: "down" };

/**
 * The step a state frame's name asks for: "Button — hover", "Button / Hover", "Button · focus",
 * "Button/State=Pressed" → "hover" | "focus" | "down"; null for any other name.
 */
export function stateStep(name) {
  const parts = String(name ?? "")
    .toLowerCase()
    .split(/\s*[—–·|/,]\s*|\s+-\s+/)
    .flatMap((p) => p.split("="))
    .map((p) => p.trim());
  for (const p of parts.slice(1)) if (STATE_STEP[p]) return STATE_STEP[p];
  return null;
}
