// Walks the React fiber tree below <PenProbe> and measures every host view, for pen-multi's verify.
// Pure JavaScript with injected React Native helpers, so it can be tested without a device.

const HOST_COMPONENT = 5;
const HOST_TEXT = 6;
const TEXT_TYPES = /^(RCTText|Text|RCTParagraph)$/;
const NESTED_TEXT = /^(RCTVirtualText|RCTRawText)$/;
const INPUT_TYPES = /TextInput|RCTSinglelineTextInputView|RCTMultilineTextInputView|RCTUITextField/;

const WEIGHTS = { thin: 100, ultralight: 200, light: 300, normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 };
export const weightOf = (w) => {
  if (w === undefined || w === null) return undefined;
  const n = Number(w);
  return Number.isFinite(n) ? n : WEIGHTS[String(w).toLowerCase()];
};

/** processColor output (0xAARRGGBB as a number) to an rgba() string; platform colors are skipped. */
export function colorString(processed) {
  if (typeof processed !== "number") return undefined;
  const n = processed >>> 0;
  const a = ((n >>> 24) & 255) / 255, r = (n >>> 16) & 255, g = (n >>> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

function textBelow(fiber) {
  let out = "";
  const walk = (f) => {
    for (let c = f; c; c = c.sibling) {
      if (c.tag === HOST_TEXT && (typeof c.memoizedProps === "string" || typeof c.memoizedProps === "number")) out += String(c.memoizedProps);
      else if (c.child) walk(c.child);
    }
  };
  walk(fiber.child);
  return out;
}

/** The object whose measureInWindow works: Fabric keeps it under canonical.publicInstance. */
export const publicInstance = (stateNode) => stateNode?.canonical?.publicInstance ?? stateNode?.canonical ?? stateNode;

/**
 * Host views below `rootFiber`, in tree order: { parent, tag, marker, text, style, inst }.
 * Nested text spans are folded into their paragraph.
 */
export function hostViews(rootFiber, { flatten = (s) => s, limit = 3000 } = {}) {
  const views = [];
  const walk = (f, parent) => {
    for (let c = f; c && views.length < limit; c = c.sibling) {
      let me = parent;
      let descend = true;
      if (c.tag === HOST_COMPONENT && typeof c.type === "string" && !NESTED_TEXT.test(c.type)) {
        const props = c.memoizedProps ?? {};
        const isText = TEXT_TYPES.test(c.type);
        const isInput = INPUT_TYPES.test(c.type);
        me = views.length;
        views.push({
          i: me,
          parent,
          tag: c.type,
          marker: [props.testID, props.nativeID].find((v) => typeof v === "string" && v.startsWith("pen:")),
          selector: props.testID ?? props.nativeID ?? props.accessibilityLabel ?? undefined,
          text: isText ? textBelow(c) : isInput ? String(props.value ?? props.defaultValue ?? props.placeholder ?? "") : undefined,
          style: flatten(props.style) ?? {},
          inst: publicInstance(c.stateNode),
          stateNode: c.stateNode,
        });
        if (isText) descend = false; // spans inside a paragraph are part of its text
      }
      if (descend && c.child) walk(c.child, me);
    }
  };
  walk(rootFiber?.child, undefined);
  return views;
}

/**
 * Measures a host view in window coordinates: through its public instance when React has created
 * one (Paper, and Fabric once accessed), else through `fallback(stateNode, callback)`, which
 * PenProbe wires to nativeFabricUIManager / UIManager for Fabric views without one yet.
 */
const measure = (view, timeoutMs, fallback) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const done = (x, y, w, h) => {
      clearTimeout(timer);
      resolve(Number.isFinite(x) && Number.isFinite(w) ? { x, y, w, h } : null);
    };
    try {
      if (view.inst && typeof view.inst.measureInWindow === "function") return view.inst.measureInWindow(done);
      if (fallback && fallback(view.stateNode, done)) return;
    } catch {
      // fall through
    }
    clearTimeout(timer);
    resolve(null);
  });

/** Snapshot elements: measured boxes plus colors, typography, radius and borders from style. */
export async function snapshotElements(rootFiber, { flatten, processColor, measureFallback, timeoutMs = 2000 } = {}) {
  const views = hostViews(rootFiber, { flatten });
  const boxes = await Promise.all(views.map((v) => measure(v, timeoutMs, measureFallback)));
  const color = (c) => (c === undefined || c === null ? undefined : colorString(processColor ? processColor(c) : c));
  const kept = new Map();
  const out = [];
  views.forEach((v, k) => {
    const box = boxes[k];
    const parent = v.parent !== undefined ? kept.get(v.parent) : undefined;
    if (!box || box.w <= 0 || box.h <= 0) {
      kept.set(v.i, parent); // children of an unmeasured view hang off its nearest measured ancestor
      return;
    }
    const s = v.style;
    const isText = v.text !== undefined;
    const el = {
      i: out.length,
      parent,
      tag: v.tag,
      selector: v.selector,
      marker: v.marker,
      text: isText ? v.text : undefined,
      box,
      bg: color(s.backgroundColor),
      fg: isText ? color(s.color ?? "black") : undefined,
      fontSize: isText ? (s.fontSize ?? 14) : undefined,
      fontWeight: isText ? (weightOf(s.fontWeight) ?? 400) : undefined,
      lineHeight: isText ? s.lineHeight : undefined,
      radius: s.borderRadius ?? s.borderTopLeftRadius,
      borderWidth: s.borderWidth ?? 0,
      borderColor: s.borderWidth ? color(s.borderColor ?? "black") : undefined,
      opacity: s.opacity,
    };
    kept.set(v.i, el.i);
    out.push(el);
  });
  return out;
}
