import { chromium } from "playwright-core";
import { loadApp, makeWorkspace, removeWorkspace, startApp } from "./bench/eval/real/workspace.mjs";
const ws = await makeWorkspace(loadApp("trading-agent"));
const stop = await startApp(ws);
try {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto(new URL(ws.routes["Phiên Mỹ đang mở"], ws.baseUrl + "/").href, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  console.log(await p.evaluate(() => {
    const el = document.elementFromPoint(300, 114);
    const cs = getComputedStyle(el);
    return { ls: cs.letterSpacing, tt: cs.textTransform, ff: cs.fontFamily, fs: cs.fontSize, fw: cs.fontWeight, tag: el.tagName, cls: el.className?.baseVal ?? el.className, html: el.outerHTML.slice(0, 300), bg: cs.backgroundColor, bgi: cs.backgroundImage.slice(0, 80), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, parent: el.parentElement?.outerHTML.slice(0, 200) };
  }));
  await b.close();
} finally { stop(); removeWorkspace(ws); }
