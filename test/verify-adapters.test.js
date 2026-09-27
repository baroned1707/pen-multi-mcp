// Native and probe adapters against fake adb / xcrun / maestro executables and a fake app polling
// the probe port, so they are tested without a device.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { captureNative } from "../src/verify/adapters/native.js";
import { captureProbe, receiveSnapshot } from "../src/verify/adapters/probe.js";
import { blank, readPng, writePng } from "../src/verify/image.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-adapters-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const log = path.join(dir, "calls.log");
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);

// A 1080×2400 screenshot: white, with a dark 1080×154 header and sparse red "glyph" pixels inside its text box.
const shot = path.join(dir, "screen.png");
const img = blank(1080, 2400, [255, 255, 255]);
for (let y = 0; y < 154; y++) for (let x = 0; x < 1080; x++) img.data.set([17, 17, 17, 255], (y * 1080 + x) * 4);
for (let y = 70; y < 80; y++) for (let x = 55; x < 145; x += 2) img.data.set([220, 38, 38, 255], (y * 1080 + x) * 4);
writePng(shot, img);

const script = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\nconst fs = require("fs");\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + args.join(" ") + "\\n");\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
};
const XML = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]"><node class="android.view.ViewGroup" resource-id="com.app:id/pen:Header" bounds="[0,0][1080,154]"><node class="android.widget.TextView" text="Checkout" bounds="[50,60][150,90]" /></node></node></hierarchy>`;
process.env.PEN_MULTI_ADB = script(
  "adb",
  `const a = args.filter((x, k) => !(x === "-s" || args[k - 1] === "-s"));
if (a[0] === "shell" && a[1] === "uiautomator") process.stdout.write(process.env.FAKE_DUMP_FAIL ? "ERROR: could not get idle state.\\n" : "UI hierchary dumped to: " + a[3] + "\\n");
else if (a[0] === "exec-out" && a[1] === "cat") process.stdout.write(${JSON.stringify(XML)});
else if (a[0] === "exec-out" && a[1] === "screencap") process.stdout.write(fs.readFileSync(${JSON.stringify(shot)}));
else if (a[0] === "shell" && a[1] === "wm") process.stdout.write("Physical density: 480\\nOverride density: 420\\n");`,
);
process.env.PEN_MULTI_XCRUN = script(
  "xcrun",
  `if (args[0] === "simctl" && args[1] === "io") fs.copyFileSync(${JSON.stringify(shot)}, args[args.length - 1]);`,
);
process.env.PEN_MULTI_MAESTRO = script(
  "maestro",
  `console.log("Connecting to device...");
console.log(JSON.stringify({ attributes: { bounds: "[0,0][360,800]" }, children: [{ attributes: { bounds: "[0,0][360,51]", "resource-id": "pen:Header" }, children: [{ attributes: { bounds: "[16,20][50,30]", text: "Checkout" }, children: [] }] }] }));`,
);

test("android native: uiautomator boxes in dp (density override wins), sampled colors, deep link first", async () => {
  fs.rmSync(log, { force: true });
  const { snapshot } = await captureNative({ platform: "android", device: "emulator-5554", deepLink: "app://checkout", settleMs: 0, screenshotPath: path.join(dir, "a.png") });
  const k = 420 / 160;
  assert.equal(snapshot.source, "uiautomator");
  assert.ok(Math.abs(snapshot.viewport.w - 1080 / k) < 0.01);
  const header = snapshot.elements.find((e) => e.marker);
  assert.equal(header.marker, "com.app:id/pen:Header");
  assert.ok(Math.abs(header.box.h - 154 / k) < 0.01);
  assert.deepEqual([header.bg.r, header.bg.g, header.bg.b], [17, 17, 17]);
  const title = snapshot.elements.find((e) => e.text === "Checkout");
  assert.equal(title.parent, header.i);
  assert.equal(title.fg.r, 220);
  const order = calls().map((c) => c.split(" ").slice(1, 5).join(" "));
  assert.match(order[0], /-s emulator-5554 shell am/);
  assert.ok(calls().every((c) => c.includes("-s emulator-5554")));
  assert.equal(readPng(path.join(dir, "a.png")).width, 1080);
});

test("ios native: simctl screenshot and maestro hierarchy, points scaled by the screenshot width", async () => {
  fs.rmSync(log, { force: true });
  const { snapshot } = await captureNative({ platform: "ios", deepLink: "app://x", settleMs: 0, screenshotPath: path.join(dir, "i.png") });
  assert.equal(snapshot.source, "maestro");
  assert.equal(snapshot.viewport.w, 360);
  assert.equal(snapshot.viewport.scale, 3);
  assert.equal(snapshot.elements[1].marker, "pen:Header");
  assert.deepEqual(calls().map((c) => c.split(" ").slice(0, 3).join(" ")), ["xcrun simctl openurl", "xcrun simctl io", "maestro hierarchy"]);
});

test("a missing tool fails with a clear message", async () => {
  const saved = process.env.PEN_MULTI_ADB;
  process.env.PEN_MULTI_ADB = path.join(dir, "no-such-adb");
  await assert.rejects(captureNative({ platform: "android", screenshotPath: path.join(dir, "x.png") }), /no-such-adb is not installed or not on PATH/);
  process.env.PEN_MULTI_ADB = saved;
  await assert.rejects(captureNative({ platform: "web", screenshotPath: path.join(dir, "x.png") }), /must be "android" or "ios"/);
});

/** A fake app: polls the probe port like PenProbe and answers each new request id once. */
function fakeApp(port, elements, { staleFirst = false } = {}) {
  let stop = false;
  const statuses = [];
  (async () => {
    let last;
    while (!stop) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/pen-probe/next`);
        const { id } = await res.json();
        if (id && id !== last) {
          last = id;
          if (staleFirst) {
            const stale = await fetch(`http://127.0.0.1:${port}/pen-probe/snapshot`, { method: "POST", body: JSON.stringify({ id: "old", elements: [] }) });
            statuses.push(stale.status);
          }
          const r = await fetch(`http://127.0.0.1:${port}/pen-probe/snapshot`, { method: "POST", body: JSON.stringify({ id, window: { width: 360, height: 800 }, elements }) });
          statuses.push(r.status);
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return { statuses, stop: () => (stop = true) };
}

test("probe: adb reverse, then the app's snapshot for this request; late answers are refused", async () => {
  fs.rmSync(log, { force: true });
  const port = 17357;
  const app = fakeApp(port, [{ box: { x: 0, y: 0, w: 360, h: 51 }, marker: "pen:Header", bg: "rgba(17, 17, 17, 1)" }, { box: { x: 0, y: 0, w: 0, h: 0 } }], { staleFirst: true });
  try {
    const { snapshot } = await captureProbe({ platform: "android", screenshotPath: path.join(dir, "p.png"), port, timeoutMs: 5000 });
    assert.equal(snapshot.source, "probe");
    assert.equal(snapshot.elements.length, 1, "zero-size views are dropped");
    assert.equal(snapshot.viewport.w, 360);
    assert.equal(snapshot.viewport.scale, 3);
    assert.deepEqual(app.statuses.slice(0, 2), [409, 204]);
    assert.match(calls()[0], /adb reverse tcp:17357 tcp:17357/);
  } finally {
    app.stop();
  }
});

test("probe: no app answering times out with instructions, and the port is released", async () => {
  await assert.rejects(receiveSnapshot({ port: 17358, timeoutMs: 300 }), /No snapshot from pen-probe within 0.3s.*PenProbe/s);
  const again = receiveSnapshot({ port: 17358, timeoutMs: 300 }).catch((e) => e.message);
  assert.match(await again, /No snapshot/, "the port was free again");
});

test("probe boxes from an edge-to-edge window (root above the window origin) are shifted to screen coordinates", async () => {
  const { probeElements } = await import("../src/verify/adapters/probe.js");
  const els = probeElements({ elements: [{ box: { x: 0, y: -49, w: 411, h: 914 } }, { parent: 0, box: { x: 0, y: -9, w: 411, h: 56 } }] });
  assert.deepEqual(els.map((e) => e.box.y), [0, 40]);
  const plain = probeElements({ elements: [{ box: { x: 0, y: 24, w: 411, h: 890 } }] });
  assert.equal(plain[0].box.y, 24, "a window that starts at the screen top keeps its offsets");
});

test("android: a failed uiautomator dump is an error, not the previous screen", async () => {
  process.env.FAKE_DUMP_FAIL = "1";
  try {
    await assert.rejects(captureNative({ platform: "android", screenshotPath: path.join(dir, "f.png") }), /uiautomator dump failed: ERROR: could not get idle state/);
    assert.ok(calls().some((c) => /shell rm -f \/sdcard\/pen-ui-/.test(c)), "the remote file is removed either way");
  } finally {
    delete process.env.FAKE_DUMP_FAIL;
  }
});

test("probe: Android status bar height moves boxes to screen coordinates; oversized posts are refused", async () => {
  const { probeElements } = await import("../src/verify/adapters/probe.js");
  const els = probeElements({ statusBarHeight: 48.76, elements: [{ box: { x: 0, y: -48.76, w: 411, h: 914 } }, { parent: 0, box: { x: 0, y: 0, w: 411, h: 56 } }] });
  assert.ok(Math.abs(els[0].box.y) < 0.01);
  assert.ok(Math.abs(els[1].box.y - 48.76) < 0.01);
  assert.equal(els.insetTop, 48.76);
  const toast = probeElements({ elements: [{ box: { x: 0, y: 0, w: 411, h: 914 } }, { box: { x: 0, y: -120, w: 411, h: 60 } }] });
  assert.equal(toast[0].box.y, 0, "a small root hidden above the screen does not shift the app");
  const port = 17359;
  const pending = receiveSnapshot({ port, timeoutMs: 3000 }).catch((e) => e.message);
  await new Promise((r) => setTimeout(r, 100));
  const res = await fetch(`http://127.0.0.1:${port}/pen-probe/snapshot`, { method: "POST", body: "x".repeat(51 * 1024 * 1024) }).catch((e) => ({ status: e.cause?.code ?? "reset" }));
  assert.ok(res.status === 413 || res.status === "ECONNRESET" || res.status === "reset" || res.status === "UND_ERR_SOCKET", `got ${res.status}`);
  assert.match(await pending, /No snapshot/);
});

test("probe: the status bar offset is checked against the screenshot (a hidden status bar means none)", async () => {
  const { chooseOffsetY } = await import("../src/verify/adapters/probe.js");
  // 100×200 logical at scale 1; a red header 40 tall drawn at y 0 (status bar hidden) or at y 24.
  const draw = (top) => {
    const im = blank(100, 200, [255, 255, 255]);
    for (let y = top; y < top + 40; y++) for (let x = 0; x < 100; x++) im.data.set([220, 38, 38, 255], (y * 100 + x) * 4);
    return im;
  };
  const body = { statusBarHeight: 24, elements: [{ box: { x: 0, y: 0, w: 100, h: 40 }, bg: "rgba(220, 38, 38, 1)" }, { box: { x: 0, y: 40, w: 100, h: 160 }, bg: "rgba(255, 255, 255, 1)" }] };
  assert.equal(chooseOffsetY(body, draw(0), 1), 0, "hidden status bar: no offset");
  assert.equal(chooseOffsetY(body, draw(24), 1), 24, "visible status bar: its height");
  assert.equal(chooseOffsetY({ elements: body.elements }, draw(0), 1), undefined, "no status bar reported (iOS)");
});
