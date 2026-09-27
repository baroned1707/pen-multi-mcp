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

/** Runs in the page: collects visible elements in document order. */
function collect(limit) {
  const out = [];
  const index = new Map();
  const sx = window.scrollX, sy = window.scrollY;
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const selector = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return `${s}#${el.id}`;
    const cls = [...el.classList].filter((c) => c.length < 40).slice(0, 2);
    if (cls.length) s += `.${cls.join(".")}`;
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return s;
  };
  const path = (el) => {
    const parts = [];
    for (let cur = el; cur && cur !== document.body && parts.length < 4; cur = cur.parentElement) parts.unshift(selector(cur));
    return parts.join(" > ");
  };
  // The part of an element's box not clipped away by ancestors with overflow other than visible.
  const clipped = (el, r) => {
    let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX === "visible" && ps.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      if (ps.overflowX !== "visible") (x1 = Math.max(x1, pr.left)), (x2 = Math.min(x2, pr.right));
      if (ps.overflowY !== "visible") (y1 = Math.max(y1, pr.top)), (y2 = Math.min(y2, pr.bottom));
      if (x2 <= x1 || y2 <= y1) return true;
    }
    return false;
  };
  // A paragraph with inline children (links, <strong>, <br>) is one text, as the design has it.
  const INLINE = /^(inline|contents)/;
  const phrasing = (el) => [...el.children].every((c) => INLINE.test(getComputedStyle(c).display) && phrasing(c));
  const owned = new Set(); // elements whose text belongs to an ancestor's paragraph
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let el = document.body; el && out.length < limit; el = walker.nextNode()) {
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    // checkVisibility covers hidden or transparent ancestors, content-visibility and closed <details>.
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
    if (!el.checkVisibility && (cs.visibility !== "visible" || Number(cs.opacity) === 0)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || clipped(el, r)) continue;
    let text = "";
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) text = el.value || el.placeholder || "";
    else if (!owned.has(el)) {
      let own = "";
      for (const c of el.childNodes) if (c.nodeType === Node.TEXT_NODE) own += c.textContent;
      if (el.children.length && phrasing(el) && (own.trim() || el.children.length > 1) && el.innerText?.trim()) {
        // innerText applies text-transform and turns <br> into a break; collapse to one line.
        text = el.innerText;
        for (const d of el.querySelectorAll("*")) owned.add(d);
      } else if (own.trim()) text = el.children.length === 0 && el.innerText ? el.innerText : own;
    }
    text = text.replace(/\s+/g, " ").trim();
    let parent;
    for (let p = el.parentElement; p; p = p.parentElement) if (index.has(p)) {
      parent = index.get(p);
      break;
    }
    const bw = Math.max(num(cs.borderTopWidth) ?? 0, num(cs.borderRightWidth) ?? 0, num(cs.borderBottomWidth) ?? 0, num(cs.borderLeftWidth) ?? 0);
    const lh = cs.lineHeight === "normal" ? undefined : num(cs.lineHeight);
    const o = {
      i: out.length,
      parent,
      tag: el.tagName.toLowerCase(),
      selector: path(el),
      marker: el.getAttribute("data-pen") || undefined,
      text: text || undefined,
      box: { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height },
      bg: cs.backgroundColor,
      fg: text ? cs.color : undefined,
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
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const pageBg = /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(bodyBg) ? getComputedStyle(document.documentElement).backgroundColor : bodyBg;
  return { elements: out, pageBg, truncated: out.length >= limit, scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight } };
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

