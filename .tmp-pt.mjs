import { chromium } from "playwright-core";
import { loadApp, makeWorkspace, removeWorkspace, startApp } from "./bench/eval/real/workspace.mjs";
const ws = await makeWorkspace(loadApp("trading-agent"));
const stop = await startApp(ws);
try {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto(new URL(ws.routes["Phiên Mỹ đang mở"], ws.baseUrl + "/").href, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  console.log(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("svg, i, [class*=icon], [data-lucide]")].slice(0, 12).map((e) => ({ tag: e.tagName, cls: String(e.className?.baseVal ?? e.className).slice(0, 60), data: [...e.attributes].filter((a) => /^data-|aria-/.test(a.name)).map((a) => a.name + "=" + a.value).join(" ").slice(0, 80), use: e.querySelector("use")?.getAttribute("href"), paths: e.querySelectorAll?.("path").length, w: Math.round(e.getBoundingClientRect().width) }))), null, 0));
  await b.close();
} finally { stop(); removeWorkspace(ws); }
