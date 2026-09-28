// Verify findings pointed at the code: where each design node (or marked UI element) is in the
// project, and which token the design uses for a differing value, under the code's name.
import { markerValue } from "./match.js";

const TOKEN_PROP = { fill: "fill", "text-color": "fill", "icon-color": "fill", border: "stroke", radius: "cornerRadius", "font-size": "fontSize", "font-weight": "fontWeight", "line-height": "lineHeight" };

/** The node as mapping.locate wants it: id, address, name, and the instance it sits in. */
function nodeRef(model, d, id) {
  const n = model.nodes.get(id);
  let instanceOf = null;
  for (let p = n; p && p !== model.root; p = model.nodes.get(p.parent)) {
    if (p.component) {
      instanceOf = { id: p.component.id, name: p.component.name };
      break;
    }
  }
  return { id, address: d.addressOf(id), name: n?.name, instanceOf };
}

/**
 * Adds `code` ("file:line"), `token` ({ design, code }) to findings in place, and returns
 * { located, unlocated, reason } for the report's hints.
 */
export function pointFindingsAtCode(findings, { model, d, snapshot, mapping }) {
  let located = 0, unlocated = 0, reason = null;
  const els = new Map((snapshot.elements ?? []).map((e, i) => [e.i ?? i, e]));
  // Files holding this screen's markers, by how many of its nodes they mark: a marker found in
  // several files ("Header/Title" on every screen) resolves to this screen's file.
  const prefer = new Map();
  for (const id of (d.nodes ?? []).map((n) => n.id)) {
    const loc = model.nodes.has(id) ? mapping.locate(nodeRef(model, d, id)) : null;
    if (loc?.file && !loc.also) prefer.set(loc.file, (prefer.get(loc.file) ?? 0) + 1);
  }
  for (const f of findings) {
    let loc = null;
    if (f.designId && model.nodes.has(f.designId)) loc = mapping.locate(nodeRef(model, d, f.designId), { prefer });
    else if (f.uiIndex !== undefined) {
      const v = markerValue(els.get(f.uiIndex)?.marker);
      const hit = v && mapping.index.markers.get(v)?.[0];
      loc = hit ? { ...hit, how: "marker" } : { reason: "the UI element has no marker" };
    }
    if (loc?.file) {
      f.code = `${loc.file}:${loc.line}${loc.also ? ` (+${loc.also} other place${loc.also > 1 ? "s" : ""} with this marker)` : ""}`;
      located++;
    } else if (loc) {
      unlocated++;
      reason ??= loc.reason;
    }
    const prop = TOKEN_PROP[f.kind];
    const raw = prop && f.designId ? model.nodes.get(f.designId)?.[prop] : undefined;
    if (typeof raw === "string" && raw.startsWith("$")) f.token = { design: raw, code: mapping.codeName(raw) ?? null };
  }
  return { located, unlocated, reason };
}
