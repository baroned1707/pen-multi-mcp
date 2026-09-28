// Web adapter: loads a URL in headless Chromium (never a visible window) and records every visible
// element's box, own text, computed colors, typography, radius, border and data-pen marker.
let playwright;
async function launch() {
  playwright ??= await import("playwright-core");
  const { chromium } = playwright;
  const tries = [];
  if (process.env.PEN_MULTI_BROWSER) tries.push({ executablePath: process.env.PEN_MULTI_BROWSER });
  tries.push({}, { channel: "chrome" });
  const errors = [];
  for (const opts of tries) {
    try {
      return await chromium.launch({ headless: true, ...opts });
    } catch (err) {
      errors.push(err.message.split("\n")[0]);
    }
  }
  throw new Error(
    `No headless browser could start (${errors.join("; ")}). Install one with "npx playwright install chromium", or set PEN_MULTI_BROWSER to a Chrome/Chromium executable.`,
  );
}

/** Runs in the page: collects visible elements in document order (open shadow roots included). */
function collect(limit) {
  // Elements of same-origin iframes need their own window's getComputedStyle.
  const gcs = (e, pseudo) => (e.ownerDocument.defaultView || window).getComputedStyle(e, pseudo);
  const out = [];
  const index = new Map();
  const sx = window.scrollX, sy = window.scrollY;
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  // nth-of-type positions, computed once per parent (a list of thousands of siblings stays linear).
  const nth = new Map();
  const nthOf = (el) => {
    const parent = el.parentElement;
    if (!parent) return null;
    if (!nth.has(parent)) {
      const counts = {}, pos = new Map();
      for (const c of parent.children) pos.set(c, (counts[c.tagName] = (counts[c.tagName] ?? 0) + 1));
      nth.set(parent, { counts, pos });
    }
    const { counts, pos } = nth.get(parent);
    return counts[el.tagName] > 1 ? pos.get(el) : null;
  };
  const selector = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return `${s}#${el.id}`;
    const cls = [...el.classList].filter((c) => c.length < 40).slice(0, 2);
    if (cls.length) s += `.${cls.join(".")}`;
    const k = nthOf(el);
    if (k) s += `:nth-of-type(${k})`;
    return s;
  };
  const path = (el) => {
    const parts = [];
    for (let cur = el; cur && cur !== document.body && parts.length < 4; cur = cur.parentElement) parts.unshift(selector(cur));
    return parts.join(" > ");
  };
  // overflow on <body> moves to the viewport when <html> has none: body then clips nothing.
  const htmlOverflowVisible = gcs(document.documentElement).overflow === "visible";
  // Clipped away entirely by an ancestor with overflow other than visible? Only ancestors that
  // contain the element's box count: an absolute box escapes static ancestors, a fixed one all.
  const clipped = (el, r, cs) => {
    if (cs.position === "fixed") return false;
    let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    let escapesStatic = cs.position === "absolute";
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = gcs(p);
      const positioned = ps.position !== "static";
      if (!(escapesStatic && !positioned) && !(p === document.body && htmlOverflowVisible) && !(ps.overflowX === "visible" && ps.overflowY === "visible")) {
        const pr = p.getBoundingClientRect();
        if (ps.overflowX !== "visible") (x1 = Math.max(x1, pr.left)), (x2 = Math.min(x2, pr.right));
        if (ps.overflowY !== "visible") (y1 = Math.max(y1, pr.top)), (y2 = Math.min(y2, pr.bottom));
        // Clipped to nothing, or to the 1px box screen-reader-only patterns leave (Drupal, old WordPress).
        if (x2 <= x1 || y2 <= y1 || (x2 - x1 <= 1 && y2 - y1 <= 1)) return true;
      }
      if (ps.position === "fixed") return false;
      if (positioned) escapesStatic = ps.position === "absolute";
    }
    return false;
  };
  const TEXT_INPUT = /^(text|search|email|url|tel|password|number|date|time|datetime-local|month|week|button|submit|reset)$/;
  const ICON_FONT = /material (icons|symbols)|icon|fontawesome|font awesome|ionicons|glyph/i;
  const pageW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const pageH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  // Clipped to nothing (screen-reader-only): the whole subtree is hidden with it. A 1px box with
  // overflow hidden is not shown itself; its children are then clipped (or escape) one by one.
  const srOnly = (r, cs) => /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\(50%/.test(cs.clipPath);
  const tiny = (r, cs) => r.width <= 1 && r.height <= 1 && cs.overflow !== "visible";
  // Parked entirely off the page (skip links, closed drawers); its children may still be on it.
  const offPage = (r, ox = 0, oy = 0) => r.right + sx + ox <= 0 || r.bottom + sy + oy <= 0 || r.left + sx + ox >= pageW || r.top + sy + oy >= pageH;
  // Literal text a ::before/::after adds ("New" badges, required asterisks); counters and icons are skipped.
  const pseudoText = (el, which) => {
    const c = gcs(el, which).content;
    if (!c || c === "none" || c === "normal") return "";
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(c);
    if (!m) return "";
    const t = m[1].replace(/\\(.)/g, "$1");
    return /^[\uE000-\uF8FF\s]*$/u.test(t) ? "" : t;
  };
  // The color an SVG paints: its first painted shape's fill (or stroke); unknown when none is set.
  const svgColor = (svg) => {
    const paint = (v) => v && v !== "none" && !/^url/.test(v) && !/^rgba\(0, 0, 0, 0\)$/.test(v);
    const declared = (el) => {
      for (let cur = el; cur; cur = cur === svg ? null : cur.parentElement) if (cur.getAttribute("fill") || cur.style.fill) return true;
      return false;
    };
    // Shapes that are drawn: not the ones inside masks, clip paths, definitions or patterns.
    const shapes = [...svg.querySelectorAll("path, circle, rect, polygon, polyline, line, ellipse, use")].filter((x) => !x.closest("mask, clipPath, defs, symbol, pattern, marker"));
    for (const shape of shapes) {
      const cs = gcs(shape);
      if (shape.getAttribute("fill") === "none") {
        if (paint(cs.stroke)) return cs.stroke;
        continue;
      }
      // <use> of a shape defined elsewhere paints that shape's own fill when it declares one.
      if (shape.tagName === "use" && cs.fill === "rgb(0, 0, 0)" && !declared(shape)) {
        const ref = (shape.getAttribute("href") || shape.getAttribute("xlink:href") || "").replace(/^#/, "");
        const target = ref && document.getElementById(ref);
        const painted = target && [target, ...target.querySelectorAll("*")].find((t) => t.getAttribute("fill") && paint(gcs(t).fill));
        if (painted) return gcs(painted).fill;
      }
      // Plain black with nothing declared is SVG's initial fill, not a choice: leave it unknown.
      if (paint(cs.fill) && !(cs.fill === "rgb(0, 0, 0)" && !declared(shape))) return cs.fill;
      if (paint(cs.stroke)) return cs.stroke;
    }
    const own = gcs(svg);
    return paint(own.fill) && (own.fill !== "rgb(0, 0, 0)" || declared(svg)) ? own.fill : undefined;
  };


  // A paragraph whose children are all inline (links, <strong>, <br>) is one text, as the design has it.
  // inline-block / inline-flex children (buttons, chips, badges) stay separate texts.
  const phrasing = (el) =>
    [...el.children].every((c) => {
      const cs = gcs(c);
      return /^(inline|contents)$/.test(cs.display) && !ICON_FONT.test(cs.fontFamily) && phrasing(c);
    });
  const owned = new Set(); // elements whose text belongs to an ancestor's paragraph

  // The element's content box (inside border and padding).
  const contentRect = (el, r, cs, dx, dy) => {
    const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0, pr = parseFloat(cs.paddingRight) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    return { x: r.left + bl + pl + dx, y: r.top + bt + pt + dy, w: Math.max(0, r.width - bl - pl - br - pr), h: Math.max(0, r.height - bt - pt - bb - pb) };
  };
  // Where the text is drawn: horizontally the union of its text nodes' glyphs (not inline icons or
  // images); vertically the first line box's top — the glyphs' top minus half the leading (glyph
  // rects sit half a leading below the line box; flex/button centering moves both together).
  const textRect = (el, content, merged, dx, dy, cs) => {
    const nodes = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === Node.TEXT_NODE && c.textContent.trim()) nodes.push(c);
        else if (merged && c.nodeType === Node.ELEMENT_NODE && !/^(svg|img|video|canvas|picture|iframe)$/i.test(c.tagName)) walk(c);
      }
    };
    walk(el);
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity, firstH = 0;
    for (const t of nodes) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(t);
      for (const q of range.getClientRects()) {
        if (q.width <= 0) continue;
        x1 = Math.min(x1, q.left);
        x2 = Math.max(x2, q.right);
        if (q.top < y1) (y1 = q.top), (firstH = q.height);
        y2 = Math.max(y2, q.bottom);
      }
    }
    if (!(x2 > x1)) return undefined;
    const lh = parseFloat(cs.lineHeight);
    const top = y1 - (Number.isFinite(lh) && lh > firstH ? (lh - firstH) / 2 : 0);
    return { x: x1 + dx, y: top + dy, w: x2 - x1, h: Math.max(1, y2 - top) };
  };
  // Every CSS color (oklch, hsl, color-mix, display-p3...) as sRGB rgba(), as the browser paints it.
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgbCache = new Map();
  const rgb = (c) => {
    if (!c || /^rgba?\(/.test(c)) return c;
    if (rgbCache.has(c)) return rgbCache.get(c);
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "rgba(0, 0, 0, 0)";
    probe.fillStyle = c;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    const out = `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
    rgbCache.set(c, out);
    return out;
  };
  // Form controls draw their value on one line centered vertically (a textarea from the top).
  const measure = document.createElement("canvas").getContext("2d");
  const controlTextRect = (el, content, cs, text) => {
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.2;
    measure.font = cs.font;
    const w = Math.min(content.w, measure.measureText(text).width);
    const y = el.tagName === "TEXTAREA" ? content.y : content.y + (content.h - lh) / 2;
    const x = cs.textAlign === "center" ? content.x + (content.w - w) / 2 : cs.textAlign === "right" || cs.textAlign === "end" ? content.x + content.w - w : content.x;
    return { x, y, w, h: lh };
  };
  const visit = (el, ox = 0, oy = 0) => {
    if (out.length >= limit) return;
    const cs = gcs(el);
    if (cs.display === "none") return;
    // visibility:hidden hides only this element (a visible child still shows): keep descending.
    const invisible = cs.visibility !== "visible";
    // checkVisibility covers transparent ancestors and closed <details>; those hide the whole subtree.
    if (!invisible && (el.checkVisibility ? !el.checkVisibility({ opacityProperty: true }) : Number(cs.opacity) === 0) && cs.display !== "contents") return;
    const r = el.getBoundingClientRect();
    if (srOnly(r, cs)) return;
    const shown = !invisible && r.width > 0 && r.height > 0 && !tiny(r, cs) && !offPage(r, ox, oy) && !clipped(el, r, cs);
    if (shown) {
      let text = "";
      let merged = false;
      if (el.tagName === "INPUT") text = TEXT_INPUT.test(el.type) ? el.value || el.placeholder || "" : "";
      else if (el.tagName === "TEXTAREA") text = el.value || el.placeholder || "";
      else if (el.tagName === "SELECT") text = el.selectedOptions?.[0]?.text ?? "";
      else if (!owned.has(el) && !ICON_FONT.test(cs.fontFamily)) {
        let own = "";
        for (const c of el.childNodes) if (c.nodeType === Node.TEXT_NODE) own += c.textContent;
        const marked = el.querySelector("[data-pen]");
        if (el.children.length && !marked && phrasing(el) && (own.trim() || el.children.length > 1) && el.innerText?.trim()) {
          // innerText applies text-transform and turns <br> into a break; collapse to one line.
          text = el.innerText;
          merged = true;
          for (const d of el.querySelectorAll("*")) owned.add(d);
        } else if (own.trim()) text = el.children.length === 0 && el.innerText ? el.innerText : own;
      }
      if (!ICON_FONT.test(cs.fontFamily) && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
        const before = pseudoText(el, "::before"), after = pseudoText(el, "::after");
        if (before || after) text = `${before} ${text} ${after}`;
      }
      text = text.replace(/\s+/g, " ").trim();
      let parent;
      for (let p = el.parentElement ?? el.getRootNode()?.host; p; p = p.parentElement ?? p.getRootNode()?.host) {
        if (index.has(p)) {
          parent = index.get(p);
          break;
        }
      }
      const bw = Math.max(num(cs.borderTopWidth) ?? 0, num(cs.borderRightWidth) ?? 0, num(cs.borderBottomWidth) ?? 0, num(cs.borderLeftWidth) ?? 0);
      const lh = cs.lineHeight === "normal" ? undefined : num(cs.lineHeight);
      // Text cut by ellipsis or line clamp still has its full DOM text; flag it.
      const truncated =
        text &&
        ((cs.textOverflow === "ellipsis" && cs.overflowX === "hidden" && el.scrollWidth > el.clientWidth + 1) ||
          (cs.webkitLineClamp && cs.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1));
      const o = {
        i: out.length,
        parent,
        tag: el.tagName.toLowerCase(),
        selector: path(el),
        marker: el.getAttribute("data-pen") || undefined,
        text: text || undefined,
        truncated: truncated || undefined,
        fixed: cs.position === "fixed" || undefined,
        sticky: cs.position === "sticky" || undefined,
        box: { x: r.left + sx + ox, y: r.top + sy + oy, w: r.width, h: r.height },
        contentBox: text ? contentRect(el, r, cs, sx + ox, sy + oy) : undefined,
        // Where the text itself is drawn inside the box (centered button labels, padded cards).
        textBox: text ? (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? controlTextRect(el, contentRect(el, r, cs, sx + ox, sy + oy), cs, text) : textRect(el, contentRect(el, r, cs, sx + ox, sy + oy), merged, sx + ox, sy + oy, cs)) : undefined,
        frame: el.tagName === "IFRAME" ? (el.contentDocument ? "same-origin" : "cross-origin") : undefined,
        bg: rgb(cs.backgroundColor),
        // Text color, or the color an icon paints (SVG fill, icon-font glyph).
        fg: rgb(text ? cs.color : el.tagName === "svg" ? svgColor(el) : ICON_FONT.test(cs.fontFamily) ? cs.color : undefined),
        icon: el.tagName === "svg" || ICON_FONT.test(cs.fontFamily) || undefined,
        fontSize: text ? num(cs.fontSize) : undefined,
        fontFamily: text ? cs.fontFamily.split(",")[0].replace(/["']/g, "").trim() : undefined,
        textAlign: text ? ({ start: "left", end: "right", justify: "left", "-webkit-center": "center" }[cs.textAlign] ?? cs.textAlign) : undefined,
        fontWeight: text ? num(cs.fontWeight) : undefined,
        lineHeight: text ? lh : undefined,
        radius: num(cs.borderTopLeftRadius),
        borderWidth: bw,
        borderColor: bw > 0 ? rgb(cs.borderTopColor) : undefined,
        opacity: Number(cs.opacity),
      };
      index.set(el, o.i);
      out.push(o);
    }
    for (const c of el.children) visit(c, ox, oy);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c, ox, oy);
    // Same-origin iframes: their content, placed at the iframe's content box.
    if (el.tagName === "IFRAME" && shown) {
      let doc = null;
      try {
        doc = el.contentDocument;
      } catch {}
      if (doc?.body) {
        const bl = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) || 0, bt = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) || 0;
        // Rects inside the iframe are relative to its viewport; the page position adds the iframe's.
        visit(doc.body, ox + r.left + bl, oy + r.top + bt);
      }
    }
  };
  visit(document.body);
  const bodyBg = gcs(document.body).backgroundColor;
  const pageBg = rgb(/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(rgb(bodyBg)) ? gcs(document.documentElement).backgroundColor : bodyBg);
  return { elements: out, pageBg, truncated: out.length >= limit, scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight } };
}

/** Scrolls through the page so content revealed on scroll (IntersectionObserver, lazy images) is shown. */
async function revealAll(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight && y < 40_000; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

async function runStep(page, step) {
  if (step.click) return page.click(step.click, { timeout: 10_000 });
  if (step.fill) return page.fill(step.fill[0], String(step.fill[1] ?? ""), { timeout: 10_000 });
  if (step.press) return page.keyboard.press(step.press);
  if (step.wait) return page.waitForTimeout(Number(step.wait));
  if (step.waitFor) return page.waitForSelector(step.waitFor, { timeout: 15_000 });
  if (step.eval) return page.evaluate(step.eval);
  throw new Error(`Unknown step ${JSON.stringify(step)}; use click, fill, press, wait, waitFor or eval.`);
}

export const WEB_FIELDS = ["text", "bg", "fg", "fontSize", "fontWeight", "lineHeight", "radius", "border"];

/** Captures `url` at `width`×`height` into { snapshot, screenshotPath }. */
export async function captureWeb({ url, steps = [], fullPage = true, width, height, colorScheme, screenshotPath, limit = 6000 }) {
  if (!/^(https?|file):/i.test(url ?? "")) throw new Error(`source.url must be an http(s) or file URL: ${url}`);
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: Math.round(width), height: Math.round(height) }, deviceScaleFactor: 1, colorScheme: colorScheme ?? "no-preference" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    if (res && res.status() >= 400) throw new Error(`${url} answered HTTP ${res.status()}`);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    for (const step of steps) await runStep(page, step);
    // content-visibility:auto sections render only near the viewport; render them all.
    await page.addStyleTag({ content: "*{content-visibility:visible !important}" }).catch(() => {});
    if (fullPage) await revealAll(page);
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForTimeout(150);
    const data = await page.evaluate(collect, limit);
    await page.screenshot({ path: screenshotPath, fullPage });
    return {
      snapshot: {
        version: 1,
        platform: "web",
        source: "dom",
        url,
        capturedAt: new Date().toISOString(),
        viewport: { w: Math.round(width), h: Math.round(height), scale: 1 },
        colorScheme,
        screenshot: screenshotPath,
        fields: WEB_FIELDS,
        truncated: data.truncated || undefined,
        pageBg: data.pageBg,
        pageErrors: errors.length ? errors.slice(0, 5) : undefined,
        elements: data.elements,
      },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

