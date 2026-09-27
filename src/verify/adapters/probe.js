// pen-probe adapter: a dev build of a React Native / Expo app with <PenProbe> polls
// http://<host>:<port>/pen-probe/next. During a capture this module listens on that port (one agent
// at a time, machine-wide), hands out a request id, and waits for the app to post its snapshot.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { readPngBuffer, writePng } from "../image.js";
import { run } from "./native.js";

export const PROBE_PORT = Number(process.env.PEN_MULTI_PROBE_PORT ?? 7357);
// Simulators and adb-reversed Android devices reach localhost; a device on Wi-Fi needs the LAN.
const PROBE_BIND = process.env.PEN_MULTI_PROBE_LAN === "1" ? "0.0.0.0" : "127.0.0.1";
export const PROBE_FIELDS = ["text", "bg", "fg", "fontSize", "fontWeight", "lineHeight", "radius", "border"];

/** Listens until one snapshot arrives or `timeoutMs` passes. Resolves to the posted body. */
export function receiveSnapshot({ port = PROBE_PORT, timeoutMs = 20_000 } = {}) {
  const id = randomUUID();
  let server;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `No snapshot from pen-probe within ${timeoutMs / 1000}s. Check that the app is a dev build running <PenProbe> (probe/react-native/PenProbe.js), ` +
            `that it can reach this machine on port ${port} (Android: adb reverse is set up automatically; a device on Wi-Fi needs PEN_MULTI_PROBE_LAN=1 and <PenProbe host="<this machine's LAN IP>">), and that the app is in the foreground.`,
        ),
      );
    }, timeoutMs);
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url.startsWith("/pen-probe/next")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id }));
      }
      if (req.method === "POST" && req.url.startsWith("/pen-probe/snapshot")) {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (body.id !== id) {
            res.writeHead(409).end(); // a late answer to an earlier capture
            return;
          }
          res.writeHead(204).end();
          clearTimeout(timer);
          resolve(body);
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`pen-probe port ${port} is unavailable (${err.code ?? err.message}); set PEN_MULTI_PROBE_PORT and the probe's port to a free one.`));
    });
    server.listen(port, PROBE_BIND);
  });
  return done.finally(() => new Promise((r) => server.close(() => r())));
}

/**
 * Validates a posted probe body and puts its boxes in screen coordinates. measureInWindow is
 * relative to the app window; with edge-to-edge layouts (Expo SDK 52+, Android 15) the window
 * starts below the status bar while the root view starts at the top of the screen, so the root
 * reports a negative y. Shifting by it lines the boxes up with the full-screen screenshot.
 */
export function probeElements(body) {
  if (!Array.isArray(body?.elements)) throw new Error("pen-probe posted no elements");
  const els = body.elements.filter((e) => e && e.box && e.box.w > 0 && e.box.h > 0).map((e, k) => ({ ...e, i: e.i ?? k }));
  const roots = els.filter((e) => e.parent === undefined || e.parent === null);
  const dx = Math.max(0, -Math.min(0, ...roots.map((e) => e.box.x)));
  const dy = Math.max(0, -Math.min(0, ...roots.map((e) => e.box.y)));
  const shifted = !dx && !dy ? els : els.map((e) => ({ ...e, box: { ...e.box, x: e.box.x + dx, y: e.box.y + dy } }));
  shifted.insetTop = dy; // the status bar height above the window
  return shifted;
}

/** Captures the app's current screen through pen-probe, plus a device screenshot. */
export async function captureProbe({ platform, device, deepLink, settleMs = 2000, timeoutMs = 20_000, screenshotPath, port = PROBE_PORT }) {
  if (platform !== "android" && platform !== "ios") throw new Error(`source.platform must be "android" or "ios", not ${platform}`);
  const adb = process.env.PEN_MULTI_ADB ?? "adb", xcrun = process.env.PEN_MULTI_XCRUN ?? "xcrun";
  const dev = device ? ["-s", device] : [];
  if (platform === "android") await run(adb, [...dev, "reverse", `tcp:${port}`, `tcp:${port}`]);
  if (deepLink) {
    if (platform === "android") await run(adb, [...dev, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", deepLink]);
    else await run(xcrun, ["simctl", "openurl", device ?? "booted", deepLink]);
    await new Promise((r) => setTimeout(r, settleMs));
  }
  const body = await receiveSnapshot({ port, timeoutMs });
  if (platform === "android") writePng(screenshotPath, readPngBuffer(await run(adb, [...dev, "exec-out", "screencap", "-p"], { binary: true })));
  else await run(xcrun, ["simctl", "io", device ?? "booted", "screenshot", "--type=png", screenshotPath]);
  const img = readPngBuffer(fs.readFileSync(screenshotPath));
  const w = body.window?.width ?? img.width;
  const scale = img.width / w;
  const elements = probeElements(body);
  return {
    snapshot: {
      version: 1,
      platform,
      source: "probe",
      device: device ?? "default",
      capturedAt: new Date().toISOString(),
      viewport: { w, h: img.height / scale, scale }, // the screenshot's height: the window may exclude system bars
      screenshot: screenshotPath,
      fields: PROBE_FIELDS,
      elements,
      insets: elements.insetTop ? { top: elements.insetTop } : undefined,
    },
  };
}
