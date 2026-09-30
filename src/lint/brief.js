// The brief's pen-rules checked on a design screen: type sizes, styles and fonts, target sizes, row
// heights, side margins, spacing, prominent actions and color roles. Findings cite the rule
// ("R1: …") and are grouped per check and screen, with a few examples each.
import { addresses } from "../design/model.js";
import { sections, shellName } from "../design/inspect.js";
import { weightOf } from "../verify/design.js";
import { anyGlob, cite } from "../context/rules.js";
import { parseColor, toHex } from "../verify/color.js";
import { tappableName } from "./rules.js";

const NOT_CONTENT = new Set(["note", "prompt", "context"]);
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);
const near = (list, v, tol = 0.5) => list.some((x) => Math.abs(x - v) <= tol);
export const family = (f) => String(f ?? "").split(",")[0].replace(/["']/g, "").replace(/\s+(variable|var|vf)$/i, "").trim().toLowerCase();
const fontOk = (families, f) => families.some((x) => family(f) === family(x) || family(f).startsWith(`${family(x)} `));

/** Side margin a rule asks for at a width: the entry with the largest width not above it. */
export function marginAt(sideMargin, width) {
  const e = Object.entries(sideMargin ?? {}).map(([w, m]) => [Number(w), m]).filter(([w]) => w <= width).sort((a, b) => b[0] - a[0])[0];
  return e ? e[1] : undefined;
}

/** [{ rule: "brief", severity, id, address, message }] for one screen model. */
export function lintBrief(model, rules) {
  const out = [];
  if (!rules || !Object.keys(rules).length) return out;
  const { addresses: addr } = addresses(model);
  const W = model.root.abs.w;
  const ignored = (group) => {
    const hit = anyGlob(rules[group]?.ignore ?? []);
    return (n) => {
      for (let cur = n; cur; cur = cur.parent ? model.nodes.get(cur.parent) : null) if (hit(cur.name) || (cur.component && hit(cur.component.name))) return true;
      return false;
    };
  };
  // Visible nodes, with whether they are inside an instance (fixed on the component, not here).
  const all = [];
  const walk = (n, inInstance) => {
    if (n.hidden || NOT_CONTENT.has(n.type)) return;
    all.push({ n, inInstance });
    for (const c of n.children) walk(c, inInstance || (Boolean(n.component) && n !== model.root));
  };
  walk(model.root, false);
  const name = (n) => addr.get(n.id) ?? n.name ?? n.id;
  const group = (group, what, hits, fmt, severity = "medium") => {
    if (!hits.length) return;
    out.push({ rule: "brief", severity, id: hits[0].id, address: name(hits[0]), message: `${cite(rules, group)}: ${what} — ${hits.length} node${hits.length > 1 ? "s" : ""}, e.g. ${hits.slice(0, 3).map((n) => `${fmt(n)} (${name(n).split("/").slice(-2).join("/")}, ${n.id})`).join("; ")}.` });
  };
  const texts = all.filter(({ n }) => n.type === "text" && String(n.resolved?.content ?? n.content ?? "").trim()).map(({ n }) => n);

  const t = rules.type;
  if (t) {
    const skip = ignored("type");
    const ts = texts.filter((n) => !skip(n));
    const size = (n) => num(n.resolved?.fontSize ?? n.fontSize);
    if (t.sizes) {
      const off = ts.filter((n) => size(n) !== undefined && !near(t.sizes, size(n)));
      const by = [...new Set(off.map(size))].sort((a, b) => a - b);
      group("type", `font size${by.length > 1 ? "s" : ""} ${by.join(", ")} not in ${t.sizes.join("/")}`, off, (n) => `${size(n)} "${String(n.resolved?.content ?? n.content).slice(0, 24)}"`);
    }
    if (t.maxStyles) {
      const key = (n) => (t.styleBy === "size+weight" ? `${size(n)}/${weightOf(n.resolved?.fontWeight ?? n.fontWeight) ?? 400}` : `${size(n)}`);
      const styles = new Map();
      // Exempt sizes (a hero figure) do not count as one of the styles.
      for (const n of ts) if (size(n) !== undefined && !near(t.exempt ?? [], size(n))) styles.set(key(n), (styles.get(key(n)) ?? 0) + 1);
      if (styles.size > t.maxStyles) {
        out.push({ rule: "brief", severity: "medium", id: model.root.id, address: name(model.root), message: `${cite(rules, "type")}: ${styles.size} text styles (max ${t.maxStyles}): ${[...styles].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ×${c}`).join(", ")}.` });
      }
    }
    if (t.families) {
      const off = ts.filter((n) => (n.resolved?.fontFamily ?? n.fontFamily) && !fontOk(t.families, n.resolved?.fontFamily ?? n.fontFamily));
      group("type", `fonts not in ${t.families.join("/")}`, off, (n) => `${n.resolved?.fontFamily ?? n.fontFamily}`);
    }
  }

  const s = rules.size;
  if (s?.minTarget) {
    const skip = ignored("size");
    const small = all
      .filter(({ n, inInstance }) => !inInstance && n !== model.root && (tappableName(n.name) || (n.component && tappableName(n.component.name))) && !skip(n))
      .map(({ n }) => n)
      .filter((n) => n.abs.w > 0 && n.abs.h > 0 && (n.abs.w < s.minTarget - 0.5 || n.abs.h < s.minTarget - 0.5));
    group("size", `tap targets under ${s.minTarget}×${s.minTarget}`, small, (n) => `${Math.round(n.abs.w)}×${Math.round(n.abs.h)}`);
  }

  const r = rules.rows;
  if (r?.heights && r.components?.length) {
    const skip = ignored("rows");
    const isRow = anyGlob(r.components);
    const off = all.filter(({ n, inInstance }) => !inInstance && n.component && isRow(n.component.name) && !skip(n) && !near(r.heights, n.abs.h)).map(({ n }) => n);
    group("rows", `row heights not ${r.heights.join(" or ")}`, off, (n) => `${Math.round(n.abs.h)} ${n.component.name}`);
  }

  const sp = rules.space;
  if (sp) {
    const skip = ignored("space");
    if (sp.scale) {
      const off = [];
      for (const { n, inInstance } of all) {
        if (inInstance || skip(n) || n.type !== "frame") continue;
        const vals = [num(n.resolved?.gap ?? n.gap), ...[].concat(n.resolved?.padding ?? n.padding ?? []).map(num)].filter((v) => v !== undefined && v > 0);
        const bad = vals.filter((v) => !near(sp.scale, v));
        if (bad.length) off.push(Object.assign(Object.create(n), { bad }));
      }
      const by = [...new Set(off.flatMap((n) => n.bad))].sort((a, b) => a - b);
      group("space", `gap/padding ${by.join(", ")} not in ${sp.scale.join("/")}`, off, (n) => n.bad.join("/"), "low");
    }
    const want = marginAt(sp.sideMargin, W);
    if (want !== undefined) {
      // Each section's left inset from the screen's edge, or from the shell on its left (a sidebar).
      // Sections side by side are panes, each measured from its own edge; bars and rails named as
      // shell are not content, and centered content (a max-width column, a dialog) is not at a
      // margin. Full-width paints (backgrounds, dividers) do not count.
      const structure = sections(model);
      const secs = structure.sections.map((x) => x.node).filter((x) => !skip(x) && x.abs.w > 0);
      const beside = (a, b) => a !== b && Math.min(a.abs.y + a.abs.h, b.abs.y + b.abs.h) - Math.max(a.abs.y, b.abs.y) > 0.5 * Math.min(a.abs.h, b.abs.h) && (a.abs.x + a.abs.w <= b.abs.x + 1 || b.abs.x + b.abs.w <= a.abs.x + 1);
      const pane = new Set(secs.filter((s) => secs.some((o) => beside(s, o))));
      const root = model.root;
      const chain = (n) => {
        const out = [];
        for (let cur = n.parent ? model.nodes.get(n.parent) : null; cur; cur = cur.parent ? model.nodes.get(cur.parent) : null) out.push(cur);
        return out;
      };
      const column = secs.length ? chain(secs[0]).find((a) => secs.every((x) => chain(x).includes(a))) ?? root : root;
      const lIn = column.abs.x - root.abs.x;
      const rIn = root.abs.x + root.abs.w - (column.abs.x + column.abs.w);
      const centeredColumn = column !== root && Math.abs(lIn - rIn) <= 2 && lIn > want + 1;
      if (secs.length && !centeredColumn) {
        const start = Math.min(...secs.map((s) => s.abs.x));
        const shellLeft = structure.shell.map((x) => x.node).filter((sh) => sh.abs.x + sh.abs.w <= start + 1 && secs.some((s) => beside(sh, s)));
        const colLeft = Math.max(root.abs.x, ...shellLeft.map((sh) => sh.abs.x + sh.abs.w));
        const colRight = root.abs.x + root.abs.w;
        const insets = [];
        for (const sec of secs) {
          // A full-width bar or a rail named as shell is not content.
          if (shellName(sec.name) && (pane.has(sec) || sec.abs.w >= colRight - colLeft - 1)) continue;
          const left = pane.has(sec) ? sec.abs.x : colLeft;
          const right = pane.has(sec) ? sec.abs.x + sec.abs.w : colRight;
          let min = Infinity;
          let max = -Infinity;
          const look = (x) => {
            if (x.hidden || NOT_CONTENT.has(x.type)) return;
            if (x !== sec && shellName(x.name) && x.abs.w >= right - left - 1) return; // a nav bar inside a pane
            const painted = x.type === "text" || x.type === "icon" || x.type === "image" || (x.fill !== undefined && x.fill !== null && x.type !== "text");
            if (painted && x.abs.w < right - left - 1 && x.abs.w > 0) {
              min = Math.min(min, x.abs.x - left);
              max = Math.max(max, x.abs.x + x.abs.w - left);
            }
            if (!(painted && x.abs.w < right - left - 1)) for (const c of x.children) look(c);
          };
          look(sec);
          const centered = Math.abs(min - (right - left - max)) <= 2 && min > want + 1;
          if (Number.isFinite(min) && !centered) insets.push({ sec, inset: min });
        }
        const off = insets.filter((x) => Math.abs(x.inset - want) > 1);
        // Only when most sections agree it is off: one full-bleed chart or a centered hero is not a margin.
        if (insets.length && off.length > insets.length / 2) {
          out.push({ rule: "brief", severity: "medium", id: off[0].sec.id, address: name(off[0].sec), message: `${cite(rules, "space")}: side margin at ${W} should be ${want}; ${off.length} of ${insets.length} sections start at ${[...new Set(off.map((x) => Math.round(x.inset)))].join(", ")} (e.g. ${off.slice(0, 3).map((x) => x.sec.name ?? x.sec.id).join(", ")}).` });
        }
      }
    }
  }

  const a = rules.action;
  if (a?.maxProminent !== undefined && a.prominentFills?.length) {
    const skip = ignored("action");
    const tokenFill = anyGlob(a.prominentFills);
    const colors = new Set(a.prominentFills.filter((f) => !f.includes("*")).map((f) => (f.startsWith("$") ? model.token(f.slice(1))?.[0]?.value : f)).map((c) => toHex(parseColor(c))).filter(Boolean));
    const prominent = (n) => {
      if (n.type === "text" || n.type === "icon") return false;
      const raw = typeof n.fill === "string" ? n.fill : n.fill?.color;
      const res = typeof n.resolved?.fill === "string" ? n.resolved.fill : n.resolved?.fill?.color;
      const color = (v) => v && colors.has(toHex(parseColor(v)));
      if (!((raw && (tokenFill(raw) || color(raw))) || color(res))) return false;
      const hasText = (x) => x.type === "text" || x.children.some(hasText);
      return tappableName(n.name) || (n.component && tappableName(n.component.name)) || (n.abs.h <= 64 && hasText(n));
    };
    const found = [];
    const look = (n, inside) => {
      if (n.hidden || NOT_CONTENT.has(n.type)) return;
      const p = !inside && n !== model.root && !skip(n) && prominent(n);
      if (p) found.push(n);
      for (const c of n.children) look(c, inside || p);
    };
    look(model.root, false);
    if (found.length > a.maxProminent) group("action", `${found.length} prominent actions (max ${a.maxProminent})`, found, (n) => `"${(n.name ?? n.id).slice(0, 24)}"`);
  }

  const c = rules.color;
  if (c) {
    const skip = ignored("color");
    const rawOf = (v) => (typeof v === "string" ? v : v?.color);
    if (c.tokensOnly) {
      const raw = all.filter(({ n, inInstance }) => !inInstance && !skip(n) && ["fill", "stroke"].some((p) => {
        const v = rawOf(n[p]);
        return typeof v === "string" && !v.startsWith("$") && (parseColor(v)?.a ?? 0) > 0.01;
      })).map(({ n }) => n);
      group("color", "raw colors instead of tokens", raw, (n) => rawOf(n.fill) ?? rawOf(n.stroke));
    }
    for (const [role, list] of [["text", c.text], ["fill", c.fill]]) {
      if (!list) continue;
      const ok = anyGlob(list);
      const off = all
        .filter(({ n, inInstance }) => !inInstance && !skip(n) && (role === "text" ? n.type === "text" : n.type !== "text" && n.type !== "icon"))
        .map(({ n }) => n)
        .filter((n) => {
          const v = rawOf(n.fill);
          return typeof v === "string" && v.startsWith("$") && !ok(v);
        });
      group("color", `${role === "text" ? "text colors" : "fills"} outside ${list.join(" ")}`, off, (n) => rawOf(n.fill), "low");
    }
  }
  return out;
}
