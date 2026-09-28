// lint and tokens against the real engine: a document with known problems, then fixes applied.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { contrast } from "../src/lint/rules.js";
import { diffTokens, normalizeTokens, renderTokens } from "../src/lint/tokens.js";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-lint-")));
const file = path.join(dir, "app.pen");
let client;
const exec = async (input) => {
  const res = await call(client, "execute", { filePath: file, input });
  assert.ok(!res.isError, text(res));
  return text(res);
};
const lint = (args = {}) => call(client, "lint", { filePath: file, target: "Home · light", maxLines: 200, ...args });
const ids = {};

before(async () => {
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" } });
  await exec(`SetVariables({
    ink: { type: "color", value: "#111111" },
    brand: { type: "color", value: "#2563EB" },
    surface: { type: "color", value: [{ value: "#FFFFFF", theme: { mode: "light" } }, { value: "#0B0B0F", theme: { mode: "dark" } }] },
    space: { type: "number", value: 16 },
    font: { type: "string", value: "Inter" },
  })`);
  const out = await exec(`s = Insert(document, { type: "frame", name: "Home · light", x: 0, y: 0, width: 390, height: 844, layout: "none", fill: "#FFFFFF", theme: { mode: "light" } });
  t1 = Insert(s, { type: "text", name: "Text", content: "Welcome back", x: 16, y: 20, fill: "#111111", fontFamily: "Inter", fontSize: 20 });
  t2 = Insert(s, { type: "text", name: "Faint", content: "Barely visible", x: 16, y: 60, fill: "#DDDDDD", fontFamily: "Inter", fontSize: 14 });
  t3 = Insert(s, { type: "text", name: "Nudged", content: "Misaligned by two", x: 18, y: 100, fill: "$ink", fontFamily: "Inter", fontSize: 14 });
  btn = Insert(s, { type: "frame", name: "Close button", x: 340, y: 16, width: 32, height: 32, fill: "$brand", cornerRadius: 16 });
  hid = Insert(s, { type: "frame", name: "Old banner", x: 0, y: 700, width: 390, height: 60, fill: "$brand", enabled: false });
  r1 = Insert(s, { type: "rectangle", name: "Rectangle 7", x: 16, y: 150, width: 358, height: 40, fill: "#2563EB" });
  r2 = Insert(s, { type: "rectangle", name: "Row", x: 16, y: 206, width: 358, height: 40, fill: "$surface" });
  r3 = Insert(s, { type: "rectangle", name: "Row", x: 16, y: 262, width: 358, height: 40, fill: "$surface" });
  r4 = Insert(s, { type: "rectangle", name: "Row", x: 16, y: 319, width: 358, height: 40, fill: "$surface" });
  Print("IDS", JSON.stringify({ t1, t2, t3, btn, hid, r1 }))`);
  Object.assign(ids, JSON.parse(/IDS (.*)/.exec(out)[1]));
});

after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lint finds the planted problems, each on the right node", async () => {
  const res = await lint();
  assert.ok(!res.isError, text(res));
  const t = text(res);
  const has = (rule, id, re) => assert.ok(t.split("\n").some((l) => l.includes(`] ${rule} `) && l.includes(`(${id})`) && (!re || re.test(l))), `${rule} on ${id}\n${t}`);
  has("contrast", ids.t2, /1\.\d:1/);
  has("misaligned", ids.t3);
  has("touch-target", ids.btn, /32×32/);
  has("hidden-layer", ids.hid);
  has("default-name", ids.t1, /rename to "Welcome back"/);
  has("default-name", ids.r1);
  has("raw-color", ids.r1, /is the value of \$brand; use the token/);
  has("raw-color", ids.t1, /is the value of \$ink/);
  assert.match(t, /uneven-spacing .*16px apart except 17px/);
  assert.doesNotMatch(t, /#FFFFFF is the value of/, "a color equal to a themed token is not auto-mapped");
  assert.match(t, /\[low\] raw-color .*#FFFFFF equals \$surface in this theme, but that token changes with the theme/);
  assert.match(t, /Safe fixes available for \d+: pass fix/);
});

test("lint fix renames default-named layers and puts tokens on exact raw colors", async () => {
  const res = await lint({ fix: ["names", "tokens"] });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /fixed \d+ findings \(names, tokens\)/);
  const out = await exec(`Print("N", JSON.stringify([Get(${JSON.stringify(ids.t1)}), Get(${JSON.stringify(ids.r1)})].map((n) => [n.name, n.fill])))`);
  assert.deepEqual(JSON.parse(/N (.*)/.exec(out)[1]), [["Welcome back", "$ink"], ["Rectangle 7", "$brand"]]);
  const again = text(await lint({ rules: ["raw-color"] }));
  assert.doesNotMatch(again, /is the value of/, "every exact match was replaced");
  assert.match(again, /#DDDDDD matches no color token/, "a color without a token is left for a person to decide");
});

test("rules filter, and the whole-document mode reports screens missing a theme", async () => {
  await exec(`for (const k of [1, 2]) { const f = Insert(document, { type: "frame", name: "Page" + k + " · light", x: 500 * k, y: 0, width: 390, height: 844, fill: "#FFFFFF", theme: { mode: "light" } }); Insert(document, { type: "frame", name: "Page" + k + " · dark", x: 500 * k, y: 900, width: 390, height: 844, fill: "#0B0B0F", theme: { mode: "dark" } }); }`);
  const res = await call(client, "lint", { filePath: file, rules: ["variants"] });
  assert.match(text(res), /variants · Home.*no dark frame, which 2 of 3 screens have/);
});

test("tokens: css with a dark block, other formats, compare with code, refuse to overwrite", async () => {
  const css = text(await call(client, "tokens", { filePath: file }));
  assert.match(css, /--ink: #111111;/);
  assert.match(css, /--space: 16px;/);
  assert.match(css, /\[data-mode="dark"\], \.dark \{\n {2}--surface: #0B0B0F;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  for (const format of ["tailwind", "json", "react-native"]) {
    const res = await call(client, "tokens", { filePath: file, format, savePath: `out/tokens.${format === "json" ? "json" : format === "tailwind" ? "tailwind.cjs" : "ts"}` });
    assert.ok(!res.isError, text(res));
  }
  const json = JSON.parse(fs.readFileSync(path.join(dir, "out/tokens.json"), "utf8"));
  assert.equal(json.dark.surface.$value, "#0B0B0F");
  assert.equal(json.light.space.$value, "16px");
  fs.writeFileSync(path.join(dir, "theme.css"), `:root { --ink: #111111; --brand: #1D4ED8; --surface: #fff; --legacy: red; }\n.dark { --surface: #0B0B0F; }\n`);
  const diff = text(await call(client, "tokens", { filePath: file, compare: "theme.css" }));
  assert.match(diff, /changed brand: design #2563EB, code #1D4ED8/);
  assert.match(diff, /missing space: design 16/);
  assert.doesNotMatch(diff, /brand \(dark\)/, "an unthemed token is compared once");
  assert.match(diff, /only in code: legacy/);
  const refused = await call(client, "tokens", { filePath: file, savePath: "theme.css" });
  assert.equal(refused.isError, true);
});

test("contrast and token helpers", () => {
  assert.equal(Math.round(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })), 21);
  const n = normalizeTokens({ a: { type: "color", value: "#fff" } }, {});
  assert.match(renderTokens(n, "css"), /--a: #fff;/);
  assert.deepEqual(diffTokens(n, ":root{--a:#FFFFFF}"), { missing: [], changed: [], extra: [] });
});

// Synthetic models for rule edge cases (no engine needed).
const mk = (id, type, abs, extra = {}) => ({ id, type, name: extra.name ?? id, abs, children: [], ...extra });
const model = (root, ...all) => {
  const nodes = new Map([root, ...all].map((n) => [n.id, n]));
  return { root, nodes, variables: {}, isToken: () => false, token: () => null };
};
const put = (parent, ...kids) => {
  for (const k of kids) {
    k.parent = parent.id;
    parent.children.push(k);
  }
};

test("contrast is not judged over images inside groups or under translucent layers", async () => {
  const { lintScreen } = await import("../src/lint/rules.js");
  const root = mk("root", "frame", { x: 0, y: 0, w: 390, h: 844 }, { fill: "#FFFFFF" });
  const hero = mk("hero", "group", { x: 0, y: 0, w: 390, h: 200 });
  const photo = mk("photo", "rectangle", { x: 0, y: 0, w: 390, h: 200 }, { fill: { type: "image", url: "x.png" } });
  const title = mk("title", "text", { x: 16, y: 150, w: 200, h: 24 }, { content: "Over a photo", fill: "#FFFFFF", fontSize: 16 });
  const scrim = mk("scrim", "rectangle", { x: 0, y: 300, w: 390, h: 100 }, { fill: "#000000", opacity: 0.05 });
  const dim = mk("dim", "text", { x: 16, y: 320, w: 200, h: 20 }, { content: "Dark on a faint scrim", fill: "#222222", fontSize: 14 });
  put(hero, photo);
  put(root, hero, title, scrim, dim);
  const f = lintScreen(model(root, hero, photo, title, scrim, dim));
  assert.deepEqual(f.filter((x) => x.rule === "contrast"), []);
});

test("a text cut by a small card is reported; rows below a scroll fold are not", async () => {
  const { lintScreen } = await import("../src/lint/rules.js");
  const root = mk("root", "frame", { x: 0, y: 0, w: 390, h: 844 }, { clip: true });
  const card = mk("card", "frame", { x: 16, y: 16, w: 200, h: 40 }, { clip: true });
  const long = mk("long", "text", { x: 24, y: 24, w: 260, h: 20 }, { content: "A label that is far too long", clipped: "partially" });
  const row = mk("row", "text", { x: 16, y: 830, w: 200, h: 30 }, { content: "Below the fold", clipped: "partially" });
  put(card, long);
  put(root, card, row);
  const f = lintScreen(model(root, card, long, row)).filter((x) => x.rule === "clipped");
  assert.deepEqual(f.map((x) => x.id), ["long"]);
});

test("touch targets: whole words only, thin indicators and parts of big buttons are skipped", async () => {
  const { lintScreen } = await import("../src/lint/rules.js");
  const root = mk("root", "frame", { x: 0, y: 0, w: 390, h: 844 });
  const nodes = [
    mk("ind", "frame", { x: 0, y: 40, w: 80, h: 2 }, { name: "Tab indicator" }),
    mk("fab", "frame", { x: 0, y: 60, w: 30, h: 30 }, { name: "Fabric swatch" }),
    mk("tbl", "frame", { x: 0, y: 100, w: 30, h: 30 }, { name: "Table header" }),
    mk("close", "frame", { x: 340, y: 10, w: 32, h: 32 }, { name: "closeButton" }),
  ];
  const big = mk("big", "frame", { x: 16, y: 700, w: 358, h: 48 }, { name: "Primary button" });
  const inner = mk("inner", "frame", { x: 30, y: 710, w: 100, h: 28 }, { name: "Button content" });
  put(big, inner);
  put(root, ...nodes, big);
  const f = lintScreen(model(root, ...nodes, big, inner)).filter((x) => x.rule === "touch-target");
  assert.deepEqual(f.map((x) => x.id), ["close"]);
});

test("tokens: round trips, var() aliases, @media dark, bracket selectors, name collisions", () => {
  const n = normalizeTokens(
    { surface: { type: "color", value: [{ value: "#FFFFFF", theme: { mode: "light" } }, { value: "#0B0B0F", theme: { mode: "dark" } }] }, ink: { type: "color", value: "#111111" } },
    { mode: ["light", "dark"] },
  );
  assert.deepEqual(diffTokens(n, renderTokens(n, "css")), { missing: [], changed: [], extra: [] });
  assert.deepEqual(diffTokens(n, renderTokens(n, "json"), { json: true }), { missing: [], changed: [], extra: [] });
  const one = normalizeTokens({ ink: { type: "color", value: "#111111" } }, {});
  assert.deepEqual(diffTokens(one, renderTokens(one, "json"), { json: true }), { missing: [], changed: [], extra: [] });
  assert.deepEqual(diffTokens(one, ":root { --white: #111111; --ink: var(--white); }").changed, []);
  assert.doesNotThrow(() => diffTokens(n, '[data-mode="light"] { --ink: #111; }'));
  assert.deepEqual(normalizeTokens({ "space-2": { type: "number", value: 8 }, space2: { type: "number", value: 9 } }, {}).collisions, ["space-2 and space2 → tokens.space2"]);
  assert.match(renderTokens(normalizeTokens({ "2xl": { type: "number", value: 32 } }, {}), "react-native"), /"2xl": 32/);
});

test("lint never puts token fixes on component instances; it checks the component instead", async () => {
  const out = await exec(`c = Insert(document, { type: "frame", name: "Chip", reusable: true, x: 0, y: -300, width: 80, height: 32, fill: "#2563EB" });
  s2 = Insert(document, { type: "frame", name: "Chips · light", x: 1600, y: 0, width: 390, height: 844, fill: "#FFFFFF", theme: { mode: "light" } });
  i = Insert(s2, { type: "ref", ref: c, name: "Chip", x: 16, y: 16 });
  Print("IDS", JSON.stringify({ c, i }))`);
  const { c, i } = JSON.parse(/IDS (.*)/.exec(out)[1]);
  const res = text(await call(client, "lint", { filePath: file, target: "Chips · light", rules: ["raw-color"], fix: ["tokens"] }));
  assert.match(res, /component Chip .*\(.*\): fill #2563EB is the value of \$brand/);
  const after = await exec(`Print("F", JSON.stringify([Get(${JSON.stringify(c)}).fill, Get(${JSON.stringify(i)}).fill]))`);
  const [compFill] = JSON.parse(/F (.*)/.exec(after)[1]);
  assert.equal(compFill, "$brand", "the component was fixed, so every instance follows");
});

test("contrast over a gradient is measured on the render when one is available", async () => {
  const { lintScreen } = await import("../src/lint/rules.js");
  const root = mk("root", "frame", { x: 0, y: 0, w: 390, h: 844 }, { fill: { type: "gradient_linear", stops: [] } });
  const t = mk("t", "text", { x: 16, y: 16, w: 200, h: 20 }, { content: "On a gradient", fill: "#7FB6EA", fontSize: 10 });
  put(root, t);
  const m = model(root, t);
  assert.deepEqual(lintScreen(m).filter((x) => x.rule === "contrast"), [], "unknown without a render");
  const light = lintScreen(m, { sampleBg: () => ({ r: 10, g: 99, b: 181, a: 1 }) }).filter((x) => x.rule === "contrast");
  assert.match(light[0].message, /2\.\d:1 .*measured on the render/);
  const dark = lintScreen(m, { sampleBg: () => ({ r: 14, g: 21, b: 35, a: 1 }) }).filter((x) => x.rule === "contrast");
  assert.deepEqual(dark, [], "8.5:1 on the real dark gradient passes");
});

test("covered: a text under a later opaque layer is reported; one under a translucent layer is not", async () => {
  const { lintScreen } = await import("../src/lint/rules.js");
  const root = mk("root", "frame", { x: 0, y: 0, w: 390, h: 844 }, { fill: "#FFFFFF" });
  const p = mk("p", "frame", { x: 0, y: 0, w: 390, h: 100 });
  const t = mk("t", "text", { x: 16, y: 16, w: 120, h: 20 }, { content: "Hidden words", fill: "#111111" });
  const box = mk("box", "frame", { x: 10, y: 10, w: 200, h: 40 }, { name: "Badge", fill: "#000000" });
  const t2 = mk("t2", "text", { x: 16, y: 60, w: 120, h: 20 }, { content: "Behind glass", fill: "#111111" });
  const glass = mk("glass", "frame", { x: 10, y: 55, w: 200, h: 40 }, { fill: "#000000", opacity: 0.3 });
  put(p, t, box, t2, glass);
  put(root, p);
  const f = lintScreen(model(root, p, t, box, t2, glass)).filter((x) => x.rule === "covered");
  assert.deepEqual(f.map((x) => x.id), ["t"]);
  assert.match(f[0].message, /hidden under "Badge"/);
});

test("covered: a row below a scroll fold is hidden by the clip, not by the tab bar after it", async () => {
  const { lintScreen } = await import("../src/lint/rules.js");
  const root = mk("root", "frame", { x: 0, y: 0, w: 390, h: 844 }, { fill: "#FFFFFF" });
  const list = mk("list", "frame", { x: 0, y: 0, w: 390, h: 760 }, { clip: true });
  const row = mk("row", "text", { x: 16, y: 780, w: 200, h: 20 }, { content: "Row 12", fill: "#111111", clipped: "fully" });
  const bar = mk("bar", "frame", { x: 0, y: 760, w: 390, h: 84 }, { name: "Tab bar", fill: "#FFFFFF" });
  put(list, row);
  put(root, list, bar);
  assert.deepEqual(lintScreen(model(root, list, row, bar)).filter((x) => x.rule === "covered"), []);
});
