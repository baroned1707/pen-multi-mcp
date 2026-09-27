import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { buildMatrix, isScreenFrame, parseScreenName } from "../src/design/names.js";

const fixture = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}-roots.json`, import.meta.url)));
// fixture rows: [type, name, width, height, reusable, themeJSON]
const frames = (f) =>
  fixture(f)
    .filter(([type]) => type === "frame")
    .map(([, name, width, height, reusable, theme]) => ({ name, width, height, reusable: !!reusable, theme: theme ? JSON.parse(theme) : null }))
    .filter(isScreenFrame);

test("near-me: code, title and theme words", () => {
  assert.deepEqual(parseScreenName("S3 · Trang tin · sáng", { width: 390 }), {
    code: "S3", screen: "S3 · Trang tin", state: null, width: 390, theme: "sáng",
  });
  assert.equal(parseScreenName("S3 · Trang tin · tối", { width: 390, theme: { mode: "toi" } }).theme, "toi");
});

test("driver-app: theme from the frame's theme property", () => {
  assert.deepEqual(parseScreenName("home · day", { width: 390, theme: { mode: "day" } }), {
    code: null, screen: "home", state: null, width: 390, theme: "day",
  });
});

test("p2p: star, uppercase state, width token", () => {
  assert.deepEqual(parseScreenName("★ M2 Tải file · ĐANG TẢI · 360", { width: 360 }), {
    code: "M2", screen: "M2 Tải file", state: "ĐANG TẢI", width: 360, theme: null,
  });
  assert.equal(parseScreenName("★ M5 Report · 1280", { width: 1280 }).width, 1280);
});

test("trading-agent: state after an em dash, W×H width, theme word as the dash part", () => {
  assert.deepEqual(parseScreenName("Hôm nay — rỗng", { width: 390, theme: { mode: "light" } }), {
    code: null, screen: "Hôm nay", state: "rỗng", width: 390, theme: "light",
  });
  const wide = parseScreenName("Hôm nay — 1280×1000", { width: 1280, theme: { mode: "light" } });
  assert.equal(wide.width, 1280);
  assert.equal(wide.state, null);
  const dark = parseScreenName("Vị thế — tối", { width: 390, theme: { mode: "dark" } });
  assert.equal(dark.screen, "Vị thế");
  assert.equal(dark.state, null);
  assert.equal(dark.theme, "dark");
});

test("a custom pattern overrides parsing", () => {
  const p = parseScreenName("Screen_Login_dark_390", { width: 390 }, { screenPattern: "^Screen_(?<screen>[^_]+)_(?<theme>[^_]+)_(?<width>\\d+)$" });
  assert.deepEqual(p, { code: null, screen: "Login", state: null, width: 390, theme: "dark" });
});

test("matrices of the four real documents: every frame lands in a row, sibling variants share one", () => {
  for (const f of ["nm", "ds", "p2p", "ta"]) {
    const m = buildMatrix(frames(f));
    const placed = m.rows.reduce((n, r) => n + Object.values(r.cells).flat().length, 0);
    assert.equal(placed + m.unparsed.length, frames(f).length, f);
  }
  const nm = buildMatrix(frames("nm"));
  const s3 = nm.rows.find((r) => r.screen === "S3 · Trang tin" && !r.state);
  assert.ok(s3, "S3 row");
  assert.ok(s3.cells[320] && s3.cells[390], "S3 is drawn at 320 and 390");
  assert.ok(s3.cells[390].some((c) => c.theme === "sáng") && s3.cells[390].some((c) => c.theme === "toi"));
  const ds = buildMatrix(frames("ds"));
  const home = ds.rows.find((r) => r.screen === "home");
  assert.deepEqual(home.cells[390].map((c) => c.theme).sort(), ["day", "night"]);
  const p2p = buildMatrix(frames("p2p"));
  const m1 = p2p.rows.find((r) => r.code === "M1" && !r.state);
  assert.ok(m1.cells[360] && m1.cells[1280], "M1 has 360 and 1280 columns");
  assert.ok(p2p.widths.includes(360) && p2p.widths.includes(1280));
});

test("a screen named like a state word is a screen, not a state", () => {
  assert.deepEqual(parseScreenName("error · day", { width: 390, theme: { mode: "day" } }), {
    code: null, screen: "error", state: null, width: 390, theme: "day",
  });
});

test("labels and flow captions are not screens", () => {
  assert.equal(isScreenFrame({ name: "→ trang chủ", width: 139, height: 39 }), false);
  assert.equal(isScreenFrame({ name: "◇ KHÁCH HÀNG", width: 1192, height: 242 }), false);
  assert.equal(isScreenFrame({ name: "C/Button", width: 400, height: 400, reusable: true }), false);
  assert.equal(isScreenFrame({ name: "home · day", width: 390, height: 844 }), true);
  const p2p = buildMatrix(frames("p2p"));
  assert.deepEqual(p2p.widths, [360, 768, 1280]);
});

test("labelled widths ('desktop 1280', 'tablet 768') join their screen's row", () => {
  assert.deepEqual(parseScreenName("S1 · Bản đồ · desktop 1280 · sáng", { width: 1280 }), {
    code: "S1", screen: "S1 · Bản đồ", state: null, width: 1280, theme: "sáng",
  });
  assert.equal(parseScreenName("S14 · Đăng bậc 0 · tablet 768 · tối", { width: 768 }).width, 768);
  assert.equal(parseScreenName("S1 · Bản đồ · 320 · sáng", { width: 320 }).screen, "S1 · Bản đồ");
});
