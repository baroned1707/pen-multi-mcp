// The brief's pen-rules checked on the running UI: what matching the design cannot catch — a size,
// font, color or target the code chose where the design had none or another. A value the code shares
// with the design is the design's problem (lint reports it), never the code's.
import { anyGlob, cite } from "../context/rules.js";
import { family, marginAt } from "../lint/brief.js";
import { colorTokens } from "../lint/rules.js";
import { deltaE, parseColor, toHex } from "./color.js";

const near = (list, v, tol = 0.5) => list.some((x) => Math.abs(x - v) <= tol);
const TAPPABLE_TAGS = new Set(["button", "input", "select", "textarea"]);

/** Lines for the "## Brief rules" part of a verify report (empty when nothing breaks a rule). */
export function briefCodeFindings(snapshot, rules, { pairs = [], design, variables = {}, theme = null } = {}) {
  const out = [];
  if (!rules || !Object.keys(rules).length) return out;
  const els = snapshot.elements ?? [];
  const byIndex = new Map(els.map((e) => [e.i, e]));
  const designOf = new Map();
  const byId = new Map((design?.nodes ?? []).map((n) => [n.id, n]));
  for (const [id, el] of pairs) if (el) designOf.set(el.i, byId.get(id));
  const ignoredBy = (group) => {
    const hit = anyGlob(rules[group]?.ignore ?? []);
    return (e) => {
      for (let cur = e, g = 0; cur && g < 100; cur = byIndex.get(cur.parent), g++) if (hit(cur.marker) || hit(cur.nameHint) || hit(cur.marker?.split("/").pop())) return true;
      return false;
    };
  };
  const where = (e) => `${e.marker ? `[data-pen="${e.marker}"]` : e.selector ?? e.tag}${e.text ? ` "${String(e.text).slice(0, 24)}"` : ""}`;
  const add = (group, what, hits, fmt) => {
    if (!hits.length) return;
    out.push(`- ${cite(rules, group)}: ${what} — ${hits.length} element${hits.length > 1 ? "s" : ""}, e.g. ${hits.slice(0, 3).map((e) => `${fmt(e)} ${where(e)}`).join("; ")}.`);
  };
  const texts = els.filter((e) => e.text && e.fontSize);

  const t = rules.type;
  if (t) {
    const skip = ignoredBy("type");
    const ts = texts.filter((e) => !skip(e));
    if (t.sizes) add("type", `font sizes not in ${t.sizes.join("/")}`, ts.filter((e) => !near(t.sizes, e.fontSize) && !(designOf.get(e.i)?.fontSize && Math.abs(designOf.get(e.i).fontSize - e.fontSize) <= 0.5)), (e) => e.fontSize);
    if (t.families) add("type", `fonts not in ${t.families.join("/")}`, ts.filter((e) => e.fontFamily && !t.families.some((f) => family(e.fontFamily) === family(f) || family(e.fontFamily).startsWith(`${family(f)} `))), (e) => e.fontFamily);
    if (t.maxStyles) {
      const count = (sizes) => new Set(sizes.filter((v) => v && !near(t.exempt ?? [], v)).map((v) => Math.round(v * 2) / 2)).size;
      const ui = count(ts.map((e) => e.fontSize));
      const drawn = count((design?.nodes ?? []).filter((n) => n.kind === "text").map((n) => n.fontSize));
      if (ui > t.maxStyles && ui > drawn) out.push(`- ${cite(rules, "type")}: ${ui} text sizes on the page (max ${t.maxStyles}; the design has ${drawn}).`);
    }
  }
  const s = rules.size;
  if (s?.minTarget) {
    const skip = ignoredBy("size");
    const small = els.filter((e) => TAPPABLE_TAGS.has(e.tag) && !skip(e) && e.box && (e.box.w < s.minTarget - 0.5 || e.box.h < s.minTarget - 0.5)).filter((e) => {
      const d = designOf.get(e.i);
      return !(d && Math.abs(d.box.w - e.box.w) <= 1 && Math.abs(d.box.h - e.box.h) <= 1);
    });
    add("size", `tap targets under ${s.minTarget}×${s.minTarget}`, small, (e) => `${Math.round(e.box.w)}×${Math.round(e.box.h)}`);
  }
  const r = rules.rows;
  if (r?.heights && r.components?.length) {
    const isRow = anyGlob(r.components);
    const off = els.filter((e) => {
      const d = designOf.get(e.i);
      return d?.component && isRow(d.component) && e.box && !near(r.heights, e.box.h) && Math.abs(d.box.h - e.box.h) > 0.5;
    });
    add("rows", `row heights not ${r.heights.join(" or ")}`, off, (e) => Math.round(e.box.h));
  }
  const sp = rules.space;
  const want = sp?.sideMargin ? marginAt(sp.sideMargin, snapshot.viewport?.w ?? 0) : undefined;
  if (want !== undefined) {
    // The texts' left edge nearest the viewport's edge, outside fixed bars: the page's side margin.
    const skip = ignoredBy("space");
    const lefts = texts.filter((e) => !e.fixed && !e.sticky && !skip(e) && e.textBox).map((e) => e.textBox.x);
    const drawnLefts = (design?.nodes ?? []).filter((n) => n.kind === "text").map((n) => n.box.x);
    const ui = lefts.length ? Math.min(...lefts) : undefined;
    const d = drawnLefts.length ? Math.min(...drawnLefts) : undefined;
    if (ui !== undefined && ui < want - 1 && (d === undefined || Math.abs(d - ui) > 1)) out.push(`- ${cite(rules, "space")}: text starts ${Math.round(ui)} from the edge at ${snapshot.viewport.w} (side margin ${want}).`);
  }
  const c = rules.color;
  if (c?.tokensOnly) {
    const tokens = colorTokens(variables, theme).map((x) => x.color);
    const skip = ignoredBy("color");
    const frame = parseColor(design?.frame?.fill);
    const onToken = (col) => tokens.some((tk) => deltaE(tk, col) < 1) || (frame && deltaE(frame, col) < 1);
    const off = [];
    for (const e of els) {
      if (skip(e)) continue;
      const d = designOf.get(e.i);
      for (const [prop, dv] of [["fg", d?.color], ["bg", d?.fill]]) {
        if (prop === "fg" && !e.text) continue;
        const col = parseColor(e[prop]);
        if (!col || col.a < 0.999) continue;
        const same = parseColor(dv);
        if (same && deltaE(same, col) < 1) continue; // the design's own color
        if (!onToken(col)) off.push({ ...e, bad: `${prop === "fg" ? "text" : "fill"} ${toHex(col)}` });
      }
    }
    add("color", "colors that are no token's value", off, (e) => e.bad);
  }
  return out;
}
