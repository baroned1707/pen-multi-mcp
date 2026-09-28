// Code → design: turns verify findings into proposed execute operations that bring the design to
// what the code shows. Only findings with a clear cause get an operation; nothing is deleted
// (a node gone from the code is hidden, with the reason); pen-multi never applies them itself.
import { colorTokens } from "../lint/rules.js";
import { tokenOrHex } from "../import/build.js";

const r2 = (v) => Math.round(v * 100) / 100;

/** An execute snippet printing `USAGE {"fontSize":[names],"cornerRadius":[names]}`: the number tokens the document uses per property. */
export const USAGE_SNIPPET = `const U = { fontSize: {}, cornerRadius: {} };
Get((n) => { for (const k of ["fontSize", "cornerRadius"]) for (const v of [].concat(n[k] ?? [])) if (typeof v === "string" && v.startsWith("$")) U[k][v.slice(1)] = 1; return undefined; });
Print("USAGE", JSON.stringify({ fontSize: Object.keys(U.fontSize), cornerRadius: Object.keys(U.cornerRadius) }));`;

/** { fontSize, radius } number-token maps from the printed usage (see USAGE_SNIPPET). */
export function propertyNumbers(variables, usageText) {
  const u = JSON.parse(/USAGE (.*)/.exec(usageText ?? "")?.[1] ?? "{}");
  return { fontSize: numberTokens(variables, u.fontSize ?? []), radius: numberTokens(variables, u.cornerRadius ?? []) };
}

/**
 * Number variables usable for one property: only those the document already uses for it
 * (`names`; a spacing token of 16 is not a font size), and only values exactly one of them has.
 * Map(value -> "$name").
 */
export function numberTokens(variables = {}, names = []) {
  const allowed = new Set(names);
  const byValue = new Map();
  for (const [name, v] of Object.entries(variables)) {
    if (!allowed.has(name) || v?.type !== "number" || Array.isArray(v.value) || typeof v.value !== "number") continue;
    byValue.set(v.value, byValue.has(v.value) ? null : `$${name}`);
  }
  return new Map([...byValue].filter(([, t]) => t));
}

/** The smallest frame of the design (outside instances) whose box holds the UI box's center. */
function containerAt(model, box) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let best = model.root;
  const inInstance = (n) => {
    for (let p = n; p; p = model.nodes.get(p.parent)) if (p.component && p !== n) return true;
    return Boolean(n.component);
  };
  for (const n of model.nodes.values()) {
    if (n.type !== "frame" || n.hidden || inInstance(n)) continue;
    const a = n.abs;
    if (cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h && a.w * a.h <= best.abs.w * best.abs.h) best = n;
  }
  return best;
}

/**
 * Proposed operations, one per finding that has a clear cause: [{ n, op, why }] plus `skipped`
 * ([{ n, why }]). `theme` is the frame's theme (color tokens resolve in it); `elements` are the
 * UI elements in design coordinates (for texts only the code has).
 */
export function designEdits(findings, { model, theme, elements = [], numbers = {} }) {
  const colors = colorTokens(model.variables, theme);
  const color = (hex) => tokenOrHex(hex, colors);
  const size = (v) => numbers.fontSize?.get(v) ?? v;
  const radius = (v) => numbers.radius?.get(v) ?? v;
  const els = new Map(elements.map((e) => [e.i, e]));
  const edits = [], skipped = [];
  const update = (f, props, why) => edits.push({ n: f.n, op: `Update(${JSON.stringify(f.designId)}, ${JSON.stringify(props)})`, why });
  for (const f of findings) {
    const node = f.designId ? model.nodes.get(f.designId) : null;
    switch (f.kind) {
      case "content":
      case "case":
        update(f, { content: f.ui }, "the text in the code");
        break;
      case "fill":
        update(f, { fill: color(f.ui) }, "the code's background");
        break;
      case "text-color":
      case "icon-color":
        update(f, { fill: color(f.ui) }, `the code's ${f.kind === "icon-color" ? "icon" : "text"} color`);
        break;
      case "border":
        if (f.ui) update(f, { stroke: color(f.ui) }, "the code's border color");
        else skipped.push({ n: f.n, why: "the code has no border; remove the stroke by hand if that is intended" });
        break;
      case "font-size":
        update(f, { fontSize: size(f.ui) }, "the code's font size");
        break;
      case "font-weight":
        update(f, { fontWeight: String(f.ui) }, "the code's font weight");
        break;
      case "line-height": {
        const size = node?.resolved?.fontSize ?? node?.fontSize;
        if (typeof size === "number" && size > 0) update(f, { lineHeight: r2(f.ui / size) }, `the code's ${f.ui}px line height`);
        else skipped.push({ n: f.n, why: "the design's font size is not a plain number" });
        break;
      }
      case "radius":
        update(f, { cornerRadius: radius(f.ui) }, "the code's corner radius");
        break;
      case "missing":
        // Hiding a container would hide the contents the code still shows.
        if (f.present?.length) skipped.push({ n: f.n, why: `${f.present.length} of its contents are still in the code; only the container differs — restructure by hand` });
        else update(f, { enabled: false }, "the code no longer shows it — hidden, not deleted; delete it yourself if it is gone for good");
        break;
      case "extra": {
        const el = els.get(f.uiIndex);
        if (!el?.text) {
          skipped.push({ n: f.n, why: "several texts; import_ui the screen for them" });
          break;
        }
        const parent = containerAt(model, el.box);
        const props = { type: "text", name: String(el.text).trim().slice(0, 32), content: String(el.text).trim() };
        const fg = color(el.fg);
        if (fg) props.fill = fg;
        if (el.fontSize) props.fontSize = size(r2(el.fontSize));
        if (el.fontWeight) props.fontWeight = String(el.fontWeight);
        if (el.fontFamily) props.fontFamily = el.fontFamily;
        edits.push({ n: f.n, op: `Insert(${JSON.stringify(parent.id)}, ${JSON.stringify(props)})`, why: `the code shows it inside ${parent.name ?? parent.id}; move it into place after inserting` });
        break;
      }
      default:
        skipped.push({ n: f.n, why: f.kind === "position" || f.kind === "size" || f.kind === "order" ? "layout: the cause (gap, padding, order, sizing) is not clear from one box" : "no single property to change" });
    }
  }
  return { edits, skipped };
}

/** The report section listing the proposed operations. */
export function editLines({ edits, skipped }, { designChanged }) {
  if (!edits.length && !skipped.length) return [];
  const lines = ["", "## Proposed design edits (code → design)"];
  if (designChanged) lines.push("⚠ The design was also edited since this frame's last verify: make sure the code, not the design, is the side to follow before applying these.");
  for (const e of edits) lines.push(`${e.n}. ${e.op}  // ${e.why}`);
  if (skipped.length) lines.push(`No edit proposed for: ${skipped.map((s) => `${s.n} (${s.why})`).join("; ")}.`);
  lines.push("Apply the ones you want with execute (they are not applied), then verify again. Values equal to a token are given as the token.");
  return lines;
}
