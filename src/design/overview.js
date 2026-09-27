// The big picture of a document: screen matrix, canvas bands, flows inferred from arrows,
// design-system usage and intent notes. Pure analysis over data read by the readRoots and
// readStats snippets, so it can be tested without the engine.
import { buildMatrix, isScreenFrame } from "./names.js";
import { tokenValues } from "./model.js";

const rect = (b) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
const clip = (s, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** First and last point of a path's first subpath, in canvas coordinates. */
export function pathEnds(geometry, viewBox, bounds) {
  if (!geometry) return null;
  const tokens = geometry.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let x = 0, y = 0, sx = 0, sy = 0, cmd = null, start = null, i = 0, subpaths = 0;
  const nums = () => {
    const out = [];
    while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) out.push(Number(tokens[i++]));
    return out;
  };
  const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const lower = cmd.toLowerCase();
    if (lower === "m") {
      if (++subpaths > 1) break; // the arrowhead is drawn as a second subpath
    }
    if (lower === "z") { x = sx; y = sy; continue; }
    const args = nums();
    const n = ARGS[lower] || 2;
    for (let k = 0; k + n <= args.length; k += n) {
      const a = args.slice(k, k + n);
      const rel = cmd === lower;
      if (lower === "h") x = rel ? x + a[0] : a[0];
      else if (lower === "v") y = rel ? y + a[0] : a[0];
      else { const nx = a[n - 2], ny = a[n - 1]; x = rel ? x + nx : nx; y = rel ? y + ny : ny; }
      if (!start) { start = [x, y]; sx = x; sy = y; }
      if (lower === "m" && k === 0) continue;
    }
  }
  if (!start) return null;
  const [vx, vy, vw, vh] = viewBox ?? [0, 0, bounds.width, bounds.height];
  const round = (v) => Math.round(v * 100) / 100;
  const map = ([px, py]) => [round(bounds.x + ((px - vx) / (vw || 1)) * bounds.width), round(bounds.y + ((py - vy) / (vh || 1)) * bounds.height)];
  return { from: map(start), to: map([x, y]) };
}

const distance = ([px, py], r) => Math.hypot(Math.max(r.x - px, 0, px - (r.x + r.w)), Math.max(r.y - py, 0, py - (r.y + r.h)));

/** Resolves a token to a plain value (first theme) for histograms. */
const plain = (variables, v) => {
  if (typeof v === "string" && v.startsWith("$")) return tokenValues(variables, v.slice(1))?.[0]?.value ?? v;
  return v;
};

export function analyze({ roots, variables = {}, themes = {} }, stats = {}, conventions = {}) {
  const frames = roots.filter((r) => r.type === "frame");
  const screens = frames.filter((f) => isScreenFrame({ ...f, width: f.bounds.width, height: f.bounds.height }));
  const components = roots.filter((r) => r.reusable);
  const labels = [
    ...roots.filter((r) => (r.type === "text" || r.type === "note" || r.type === "context") && r.content),
    ...frames.filter((f) => !f.reusable && !screens.includes(f)),
  ].map((l) => ({ id: l.id, text: clip(l.content ?? l.name, 120), r: rect(l.bounds), kind: l.type }));

  const matrix = buildMatrix(
    screens.map((f) => ({ id: f.id, name: f.name, width: f.bounds.width, height: f.bounds.height, theme: f.theme })),
    conventions,
  );
  const screenById = new Map(screens.map((s) => [s.id, s]));

  // Bands: screens stacked by y; a vertical gap > 400 starts a new band.
  const byY = [...screens].sort((a, b) => a.bounds.y - b.bounds.y);
  const bands = [];
  for (const s of byY) {
    const last = bands.at(-1);
    if (last && s.bounds.y <= last.bottom + 400) {
      last.screens.push(s);
      last.bottom = Math.max(last.bottom, s.bounds.y + s.bounds.height);
    } else bands.push({ top: s.bounds.y, bottom: s.bounds.y + s.bounds.height, screens: [s] });
  }
  for (const b of bands) {
    const left = Math.min(...b.screens.map((s) => s.bounds.x));
    // The band title is the most prominent (tallest) label near the band's top-left, not a row label.
    const candidates = labels.filter((l) => l.r.y <= b.top + 200 && l.r.y >= b.top - 800 && l.r.x <= left + 400);
    candidates.sort((p, q) => q.r.h - p.r.h || Math.abs(b.top - p.r.y) - Math.abs(b.top - q.r.y));
    b.label = candidates[0]?.text ?? null;
  }

  // Flows: root-level paths whose two ends touch two different screens.
  const flows = [];
  for (const p of roots.filter((r) => r.type === "path")) {
    const ends = pathEnds(p.geometry, p.viewBox, p.bounds);
    if (!ends) continue;
    const nearest = (pt) =>
      screens.map((s) => ({ s, d: distance(pt, rect(s.bounds)) })).sort((a, b) => a.d - b.d)[0];
    const a = nearest(ends.from), b = nearest(ends.to);
    if (!a || !b || a.s === b.s || a.d > 80 || b.d > 80) continue;
    const mid = [(ends.from[0] + ends.to[0]) / 2, (ends.from[1] + ends.to[1]) / 2];
    const label = labels
      .map((l) => ({ l, d: distance(mid, l.r) }))
      .filter((x) => x.d <= 150)
      .sort((x, y) => x.d - y.d)[0]?.l.text?.replace(/^→\s*/, "");
    flows.push({ from: a.s.name, to: b.s.name, label: label ?? null, confidence: a.d <= 48 && b.d <= 48 ? "high" : "low" });
  }
  for (const f of conventions.flowEdges ?? []) flows.push({ from: f.from, to: f.to, label: f.ev ?? f.label ?? null, confidence: "declared" });

  // Design system usage from per-root statistics.
  const compName = new Map(components.map((c) => [c.id, c.name]));
  const usage = new Map();
  const count = (map, k, n = 1) => map.set(k, (map.get(k) ?? 0) + n);
  const fontSizes = new Map(), spacing = new Map(), rawFills = new Map();
  let tokenFills = 0;
  const notes = [];
  for (const [rootId, s] of Object.entries(stats)) {
    for (const [ref, n] of Object.entries(s.refs ?? {})) {
      const u = usage.get(ref) ?? { instances: 0, screens: new Set() };
      u.instances += n;
      if (screenById.has(rootId)) u.screens.add(screenById.get(rootId).name);
      usage.set(ref, u);
    }
    for (const [id, name] of s.reusable ?? []) compName.set(id, name);
    for (const v of s.fontSizes ?? []) count(fontSizes, plain(variables, v));
    for (const v of s.spacing ?? []) count(spacing, plain(variables, v));
    for (const [hex, n] of Object.entries(s.rawFills ?? {})) count(rawFills, hex, n);
    tokenFills += s.tokenFills ?? 0;
    notes.push(...(s.notes ?? []));
  }
  const scale = (map) => {
    const entries = [...map].filter(([k]) => typeof k === "number").sort((a, b) => b[1] - a[1]);
    return { used: entries, offScale: entries.filter(([, n]) => n <= 2).map(([k]) => k).sort((a, b) => a - b) };
  };

  const varTypes = {};
  for (const v of Object.values(variables)) varTypes[v.type] = (varTypes[v.type] ?? 0) + 1;

  return {
    counts: { roots: roots.length, screens: screens.length, components: compName.size, labels: labels.length, paths: roots.filter((r) => r.type === "path").length },
    themes,
    variables: varTypes,
    matrix,
    bands,
    flows,
    components: [...compName].map(([id, name]) => ({ id, name, instances: usage.get(id)?.instances ?? 0, screens: [...(usage.get(id)?.screens ?? [])] }))
      .sort((a, b) => b.instances - a.instances),
    typeScale: scale(fontSizes),
    spacing: scale(spacing),
    fills: { token: tokenFills, raw: [...rawFills].sort((a, b) => b[1] - a[1]) },
    notes: [...notes, ...labels.filter((l) => l.kind === "note" || l.kind === "context").map((l) => l.text)],
  };
}

const matches = (focus, row) => {
  if (!focus) return true;
  const f = focus.toLowerCase();
  return row.code?.toLowerCase() === f || row.screen.toLowerCase().includes(f) || Object.values(row.cells).flat().some((c) => c.id === focus);
};

/** Text rendering, capped at maxLines; `focus` narrows to matching screens and their flows. */
export function renderOverview(a, { file, focus, maxRows = 60, maxLines = 250 } = {}) {
  const L = [];
  const themeAxes = Object.entries(a.themes).map(([k, v]) => `${k} = ${v.join(", ")}`).join("; ") || "none";
  L.push(`# Overview: ${file}`);
  L.push(`${a.counts.roots} root nodes: ${a.counts.screens} screens, ${a.counts.components} components, ${a.counts.labels} labels/notes, ${a.counts.paths} paths`);
  L.push(`Themes: ${themeAxes} · variables: ${Object.entries(a.variables).map(([t, n]) => `${t} ${n}`).join(", ") || "none"}`);
  L.push("");
  const rows = a.matrix.rows.filter((r) => matches(focus, r));
  const widths = a.matrix.widths;
  L.push(`## Screens: ${rows.length} rows × widths ${widths.join(" ")} (cells list themes; – = not drawn)`);
  L.push(`screen${" ".repeat(1)}| state | ${widths.join(" | ")}`);
  for (const r of rows.slice(0, maxRows)) {
    const cells = widths.map((w) => (r.cells[w] ? r.cells[w].map((c) => c.theme ?? "✓").join(",") : "–"));
    L.push(`${r.screen} | ${r.state ?? ""} | ${cells.join(" | ")}`);
  }
  if (rows.length > maxRows) L.push(`… ${rows.length - maxRows} more rows: call overview with focus (a screen code or name)`);
  if (focus) {
    for (const r of rows) for (const [w, cs] of Object.entries(r.cells)) for (const c of cs) L.push(`  ${c.name} → id ${c.id} (${w}${c.theme ? `, ${c.theme}` : ""})`);
  }
  if (a.matrix.unparsed.length) L.push(`Unparsed screen names: ${a.matrix.unparsed.map((u) => u.name).join("; ")}`);
  L.push("");
  if (!focus) {
    L.push(`## Bands (top to bottom)`);
    a.bands.forEach((b, i) => L.push(`${i + 1}. y ${Math.round(b.top)}–${Math.round(b.bottom)}${b.label ? ` "${b.label}"` : ""}: ${b.screens.length} screens (${b.screens.slice(0, 6).map((s) => s.name).join("; ")}${b.screens.length > 6 ? "; …" : ""})`));
    L.push("");
  }
  const names = new Set(rows.flatMap((r) => Object.values(r.cells).flat().map((c) => c.name)));
  const flows = a.flows.filter((f) => !focus || names.has(f.from) || names.has(f.to));
  L.push(`## Flows: ${flows.length} (${flows.filter((f) => f.confidence === "declared").length} declared, others inferred from arrows)`);
  for (const f of flows.slice(0, 60)) L.push(`${f.from} → ${f.to}${f.label ? ` "${f.label}"` : ""}${f.confidence === "low" ? " (low confidence)" : ""}`);
  if (flows.length > 60) L.push(`… ${flows.length - 60} more`);
  L.push("");
  const comps = focus ? a.components.filter((c) => c.screens.some((s) => names.has(s))) : a.components;
  L.push(`## Components: ${comps.length}`);
  for (const c of comps.slice(0, 40)) L.push(`${c.name} (${c.id}): ${c.instances} instances in ${c.screens.length} screens`);
  if (comps.length > 40) L.push(`… ${comps.length - 40} more`);
  if (!focus) {
    L.push("");
    const fmt = (s) => s.used.slice(0, 16).map(([v, n]) => `${v}×${n}`).join(" ");
    L.push(`## Type scale (font sizes in use): ${fmt(a.typeScale)}${a.typeScale.offScale.length ? ` · used ≤2 times: ${a.typeScale.offScale.join(", ")}` : ""}`);
    L.push(`## Spacing (gap/padding in use): ${fmt(a.spacing)}${a.spacing.offScale.length ? ` · used ≤2 times: ${a.spacing.offScale.join(", ")}` : ""}`);
    L.push(`## Fills: ${a.fills.token} use variables, ${a.fills.raw.reduce((s, [, n]) => s + n, 0)} raw${a.fills.raw.length ? ` (${a.fills.raw.slice(0, 6).map(([h, n]) => `${h}×${n}`).join(" ")})` : ""}`);
    if (a.notes.length) {
      L.push("");
      L.push(`## Intent (notes and context)`);
      for (const n of a.notes.slice(0, 20)) L.push(`- ${clip(n, 200)}`);
    }
  }
  if (L.length > maxLines) return [...L.slice(0, maxLines), `… output cut at ${maxLines} lines: use focus to narrow it`];
  return L;
}
