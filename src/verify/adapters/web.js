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
  const htmlOverflowVisible = getComputedStyle(document.documentElement).overflow === "visible";
  // Clipped away entirely by an ancestor with overflow other than visible? Only ancestors that
  // contain the element's box count: an absolute box escapes static ancestors, a fixed one all.
  const clipped = (el, r, cs) => {
    if (cs.position === "fixed") return false;
    let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    let escapesStatic = cs.position === "absolute";
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = getComputedStyle(p);
      const positioned = ps.position !== "static";
      if (!(escapesStatic && !positioned) && !(p === document.body && htmlOverflowVisible) && !(ps.overflowX === "visible" && ps.overflowY === "visible")) {
        const pr = p.getBoundingClientRect();
        if (ps.overflowX !== "visible") (x1 = Math.max(x1, pr.left)), (x2 = Math.min(x2, pr.right));
        if (ps.overflowY !== "visible") (y1 = Math.max(y1, pr.top)), (y2 = Math.min(y2, pr.bottom));
        if (x2 <= x1 || y2 <= y1) return true;
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
  // Present for assistive technology only, or parked off the page (skip links, closed drawers).
  const offstage = (r, cs) =>
    (r.width <= 1 && r.height <= 1) ||
    /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) ||
    /inset\(50%/.test(cs.clipPath) ||
    r.right + sx <= 0 || r.bottom + sy <= 0 || r.left + sx >= pageW || r.top + sy >= pageH;
  // A paragraph whose children are all inline (links, <strong>, <br>) is one text, as the design has it.
  // inline-block / inline-flex children (buttons, chips, badges) stay separate texts.
  const phrasing = (el) =>
    [...el.children].every((c) => {
      const cs = getComputedStyle(c);
      return /^(inline|contents)$/.test(cs.display) && !ICON_FONT.test(cs.fontFamily) && phrasing(c);
    });
  const owned = new Set(); // elements whose text belongs to an ancestor's paragraph

  const visit = (el) => {
    if (out.length >= limit) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return;
    // visibility:hidden hides only this element (a visible child still shows): keep descending.
    const invisible = cs.visibility !== "visible";
    // checkVisibility covers transparent ancestors and closed <details>; those hide the whole subtree.
    if (!invisible && (el.checkVisibility ? !el.checkVisibility({ opacityProperty: true }) : Number(cs.opacity) === 0) && cs.display !== "contents") return;
    const r = el.getBoundingClientRect();
    const shown = !invisible && r.width > 0 && r.height > 0 && !offstage(r, cs) && !clipped(el, r, cs);
    if (shown) {
      let text = "";
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
          for (const d of el.querySelectorAll("*")) owned.add(d);
        } else if (own.trim()) text = el.children.length === 0 && el.innerText ? el.innerText : own;
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
        fixed: cs.position === "fixed" || cs.position === "sticky" || undefined,
        box: { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height },
        bg: cs.backgroundColor,
        // Text color, or the color an icon paints (SVG fill, icon-font glyph).
        fg: text ? cs.color : el.tagName === "svg" ? (cs.fill && cs.fill !== "none" && !/^url/.test(cs.fill) ? cs.fill : cs.color) : ICON_FONT.test(cs.fontFamily) ? cs.color : undefined,
        icon: el.tagName === "svg" || ICON_FONT.test(cs.fontFamily) || undefined,
        fontSize: text ? num(cs.fontSize) : undefined,
        fontWeight: text ? num(cs.fontWeight) : undefined,
        lineHeight: text ? lh : undefined,
        radius: num(cs.borderTopLeftRadius),
        borderWidth: bw,
        borderColor: bw > 0 ? cs.borderTopColor : undefined,
        opacity: Number(cs.opacity),
      };
      index.set(el, o.i);
      out.push(o);
    }
    for (const c of el.children) visit(c);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c);
  };
  visit(document.body);
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const pageBg = /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(bodyBg) ? getComputedStyle(document.documentElement).backgroundColor : bodyBg;
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

