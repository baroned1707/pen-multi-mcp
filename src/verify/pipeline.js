// The comparison pipeline without I/O: scale the snapshot into design units, match, compare,
// add pixel regions, number the findings, and summarize.
import { compare, DEFAULT_TOLERANCE, sortFindings, summarize } from "./compare.js";
import { deltaE, flatten, parseColor, toHex } from "./color.js";
import { match } from "./match.js";
import { resize } from "./image.js";
import { boxDiffers, nodesAt, pixelRegions } from "./visual.js";

const FIELD_NAMES = { text: "text", bg: "fill color", fg: "text color", fontSize: "font size", fontWeight: "font weight", lineHeight: "line height", radius: "corner radius", border: "borders" };

/**
 * Snapshot elements in design units. Logical pixels, dp and pt are all the design's unit, so boxes
 * are not scaled: a device wider than the design frame is handled by comparing margins
 * (see compare), and fixed sizes such as font sizes stay comparable.
 */
export function toDesignUnits(snapshot) {
  return { s: 1, viewportW: snapshot.viewport?.w, pageBg: snapshot.pageBg, elements: (snapshot.elements ?? []).map((el) => ({ ...el, box: { ...el.box } })) };
}

/**
 * The UI is one element (source.element) and the design a component: the frame's own fill and
 * corner radius are the element's background and radius (a hover or pressed look is usually just
 * these).
 */
export function elementFindings(design, snapshot, tolerance = {}) {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };
  const out = [];
  const f = design.frame;
  const el = snapshot.element;
  const at = { x: 0, y: 0, w: f.w, h: f.h };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const want = parseColor(f.fill);
  if (want && want.a > 0) {
    const got = parseColor(el.bg);
    const under = flatten(parseColor(snapshot.page?.pageBg) ?? white, white);
    const shown = got && got.a > 0 ? flatten(got, under) : null;
    const d = shown ? deltaE(flatten(want, white), shown) : Infinity;
    // Both are exact values (the design's and the computed style), not sampled pixels: a hover
    // shade one step darker (ΔE ≈ 9) must count, so the tolerance is tight unless one is given.
    if (d > (tolerance.color ?? 2.5)) out.push({ severity: "high", group: "Color", kind: "fill", designId: f.id, address: f.name, box: at, ui: shown ? toHex(shown) : "none", message: `fill: ${shown ? toHex(shown) : "none"} on the element (${el.selector}), ${toHex(want)} in the design${Number.isFinite(d) ? ` (ΔE ${Math.round(d)})` : ""} — ${f.name} (${f.id}).` });
  }
  if (f.radius !== undefined) {
    const wantR = Math.min(f.radius, f.w / 2, f.h / 2), gotR = Math.min(el.radius ?? 0, el.box.w / 2, el.box.h / 2);
    if (Math.abs(gotR - wantR) > tol.radius) out.push({ severity: "medium", group: "Layout", kind: "radius", designId: f.id, address: f.name, box: at, ui: gotR, message: `corner radius: ${Math.round(gotR * 10) / 10} on the element (${el.selector}), ${Math.round(wantR * 10) / 10} in the design — ${f.name} (${f.id}).` });
  }
  return out;
}

/**
 * Compares a design screen (from designNodes) with a UI snapshot. `designImg`/`uiImg` (decoded
 * PNGs) add pixel regions when both are given.
 */
export function verifyScreen({ design, snapshot, designImg, uiImg, tolerance }) {
  const fields = snapshot.fields ?? [];
  const ui = toDesignUnits(snapshot);
  const imageOnly = ui.elements.length === 0;
  const matched = imageOnly
    ? { pairs: new Map(), unmatchedDesign: [], unmatchedUi: [], markerMisses: [] }
    : match(design, ui);
  const findings = imageOnly ? [] : compare(design, ui, matched, { tolerance, fields, viewportW: ui.viewportW, viewportH: snapshot.viewport?.h });
  const own = snapshot.element ? elementFindings(design, snapshot, tolerance) : [];
  findings.push(...own);

  if (designImg && uiImg) {
    // Texts already compared as elements are skipped: anti-aliasing differs between renderers.
    const chromeBoxes = (design.deviceChrome ?? []).map((c) => c.box);
    if (snapshot.insets?.top) chromeBoxes.push({ x: 0, y: 0, w: design.frame.w, h: snapshot.insets.top }); // the device's own status bar
    const ignore = [...chromeBoxes, ...(imageOnly ? [] : design.nodes.filter((n) => n.kind === "text" && matched.pairs.has(n.id)).map((n) => n.box))];
    // A device wider or narrower than the frame shifts right- and center-anchored elements that the
    // element comparison accepted; their pixels (at both places) are not differences.
    // Only leaves (texts, icons, instances, shapes without compared contents): ignoring a section
    // would hide whatever inside it differs. Fixed bars drawn against the viewport likewise.
    // Their pixels are compared box to box instead, so a wrong image or icon is still caught.
    if (!imageOnly) {
      const wider = ui.viewportW && Math.abs(ui.viewportW - design.frame.w) > 2;
      const flaggedIds = new Set(findings.filter((f) => f.designId).map((f) => f.designId));
      const hasInside = new Set(design.nodes.flatMap((n) => n.ancestors ?? []));
      const k = designImg.width / design.frame.w;
      let uiScaled = null;
      for (const [id, p] of matched.pairs) {
        const n = design.nodes.find((x) => x.id === id);
        // Fixed bars (often shells with contents) move as a whole: compare them box to box too.
        if (flaggedIds.has(id) || (!p.el.fixed && (p.how === "content" || n.kind === "section" || n.kind === "shell" || hasInside.has(id)))) continue;
        if (!wider && !p.el.fixed) continue;
        // Padded: a comparison cell straddling the edge would otherwise count half a bar as a difference.
        const pad = (b) => ({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 });
        ignore.push(pad(n.box), pad(p.el.box));
        if (n.kind === "text") continue; // texts were compared as text
        uiScaled ??= resize(uiImg, Math.round((snapshot.viewport?.w ?? design.frame.w) * k));
        if (boxDiffers(designImg, k, n.box, uiScaled, p.el.box)) {
          findings.push({ severity: "medium", group: "Visual", kind: "pixels", designId: id, uiIndex: p.el.i, box: p.el.box, message: `pixels differ inside ${n.address ?? n.name} (${id}): the element is where it belongs but does not look like the design (image, icon or drawing).` });
        }
      }
    }
    const opts = imageOnly ? { cell: 8, threshold: 12 } : { cell: 12, threshold: 15, minCells: 3 };
    const { regions, differentHeight } = pixelRegions(designImg, design.frame, uiImg, { ...opts, ignore, max: Infinity, uiWidth: snapshot.viewport?.w });
    const flagged = new Set(findings.filter((f) => f.designId).flatMap((f) => [f.designId, ...(f.contains ?? [])]));
    // Regions on nodes that already have a finding add nothing; the rest are listed, largest first.
    const named = regions.map((r) => ({ r, nodes: nodesAt(design, r) }));
    // A region can also be where the UI moved something to: check the matched UI elements there too.
    const movedHere = (r) => {
      const b = r.box;
      return [...matched.pairs.entries()].some(([id, p]) => {
        const u = p.el.box;
        const w = Math.min(b.x + b.w, u.x + u.w) - Math.max(b.x, u.x), h = Math.min(b.y + b.h, u.y + u.h) - Math.max(b.y, u.y);
        return w > 0 && h > 0 && (w * h) / (b.w * b.h) >= 0.3 && flagged.has(id);
      });
    };
    // A region on no node of a component whose own fill or radius differs: that finding explains it.
    const unexplained = imageOnly ? named : named.filter((x) => !x.nodes.some((n) => flagged.has(n.id)) && !movedHere(x.r) && !(own.length && !x.nodes.length));
    const explained = named.length - unexplained.length;
    const LIST = 15;
    for (const { r, nodes } of unexplained.slice(0, LIST)) {
      const names = nodes.map((n) => `${n.address ?? n.name} (${n.id})`).join(", ");
      findings.push({
        severity: "medium",
        group: "Visual",
        kind: "pixels",
        box: r.box,
        designId: nodes[0]?.id,
        message: `pixels differ in ${Math.round(r.box.w)}×${Math.round(r.box.h)} @${Math.round(r.box.x)},${Math.round(r.box.y)}${names ? ` — design there: ${names}` : " — outside every compared node"}.`,
      });
    }
    const dropped = Math.max(0, unexplained.length - LIST);
    if (explained || dropped) {
      const parts = [explained && `${explained} differing regions lie on nodes reported above`, dropped && `${dropped} smaller differing regions are not listed`].filter(Boolean);
      findings.push({ severity: "low", group: "Visual", kind: "pixels", message: `${parts.join("; ")}.` });
    }
    if (differentHeight) {
      findings.push({
        severity: "low",
        group: "Visual",
        kind: "height",
        message: `height: the UI screenshot is ${Math.round(differentHeight.ui)} tall, the design ${Math.round(differentHeight.design)} (a scrolling page or a missing/extra section).`,
      });
    }
  }

  sortFindings(findings);
  findings.forEach((f, k) => (f.n = k + 1));
  const summary = summarize(design, matched, findings);
  if (imageOnly) {
    summary.matched = 0;
    summary.score = null;
  }
  const notCompared = Object.entries(FIELD_NAMES).filter(([k]) => !fields.includes(k)).map(([, v]) => v);
  const hints = [];
  const geometry = [...matched.pairs.entries()].filter(([, p]) => p.how === "geometry").map(([id]) => design.nodes.find((n) => n.id === id));
  if (!imageOnly && summary.by.marker === 0) {
    hints.push(`No markers found. Add data-pen="<address>" (web) or testID="pen:<address>" (React Native) to sections, component instances and texts, using the addresses in this report, so matching is exact.`);
  } else if (geometry.length) {
    hints.push(`${geometry.length} nodes were matched by position only; mark them for exact matching: ${geometry.slice(0, 6).map((n) => n.address ?? n.name).join(", ")}${geometry.length > 6 ? ", …" : ""}.`);
  }
  const vw = ui.viewportW;
  if (vw && Math.abs(vw - design.frame.w) > 2) {
    hints.push(`The UI is ${Math.round(vw)} wide and the design ${design.frame.w}: positions are compared by their left, right or center anchor, widths by their margins.${Math.abs(vw - design.frame.w) / design.frame.w > 0.15 ? " That is a large gap; pass width to pick the design variant for this device." : ""}`);
  }
  if (design.deviceChrome?.length) hints.push(`Not compared: device chrome drawn in the mockup (${[...new Set(design.deviceChrome.map((c) => c.name))].join(", ")}).`);
  if (imageOnly) hints.push("Image-only source: findings are pixel regions named after the design nodes there. A web URL, pen-probe or a native source gives element-level findings.");
  if (snapshot.truncated) hints.push("The page has more elements than were captured; verify a narrower state or screen.");
  for (const e of snapshot.pageErrors ?? []) hints.push(`Page error while loading: ${e}`);
  // The matched pairs, for the sync record (not part of the report).
  const pairs = [...matched.pairs].map(([id, p]) => [id, p.el]);
  return { summary, findings, notCompared, hints, scale: ui.s, pairs };
}
