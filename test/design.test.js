// overview and inspect against the real engine, on a document built here with the cases that
// tripped agents in real projects.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { call, connect, text } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-design-")));
const file = path.join(dir, "app.pen");
let client;
const exec = async (input) => {
  const res = await call(client, "execute", { filePath: file, input });
  assert.ok(!res.isError, text(res));
  return text(res);
};

before(async () => {
  client = await connect({ home: path.join(dir, "home"), cwd: dir });
  await exec(`SetVariables({
    bg: { type: "color", value: [{ value: "#FFFFFF", theme: { mode: "light" } }, { value: "#111111", theme: { mode: "dark" } }] },
    ink: { type: "color", value: [{ value: "#111111", theme: { mode: "light" } }, { value: "#EEEEEE", theme: { mode: "dark" } }] },
    s16: { type: "number", value: 16 },
  })`);
  // Components: an icon, and a button that contains the icon.
  await exec(`ic = Insert(document, { type: "frame", name: "C/Dot", reusable: true, x: 0, y: -600, width: 12, height: 12, fill: "$ink" });
  btn = Insert(document, { type: "frame", name: "C/Button", reusable: true, x: 100, y: -600, layout: "horizontal", gap: 8, padding: [10, 16], fill: "$ink", cornerRadius: 8 });
  Insert(btn, { type: "ref", ref: ic, name: "Dot" });
  lbl = Insert(btn, { type: "text", name: "Label", content: "Go", fill: "$bg", fontFamily: "Inter", fontSize: 14 });
  Print("IDS", JSON.stringify({ ic, btn, lbl }))`);
  const comps = await exec(`Print("C", JSON.stringify(Get((n, c) => { c.skipChildren(); return n.reusable ? [n.name, n.id] : undefined; })))`);
  const ids = Object.fromEntries(JSON.parse(/^C (.*)$/m.exec(comps)[1]));
  const labelId = JSON.parse(/"lbl":"(\w+)"/.exec(await exec(`Print(JSON.stringify({ lbl: Get(${JSON.stringify(ids["C/Button"])}, { depth: 1 }).children.find(c => c.name === "Label").id }))`))[1].replace(/.*/, (m) => `"${m}"`));
  for (const [name, x, y, theme] of [["Home · light", 0, 0, "light"], ["Home · dark", 0, 1000, "dark"], ["Checkout · light", 600, 0, "light"]]) {
    await exec(`s = Insert(document, { type: "frame", name: ${JSON.stringify(name)}, x: ${x}, y: ${y}, width: 390, height: 844, layout: "vertical", clip: true, fill: "$bg", theme: { mode: ${JSON.stringify(theme)} } });
    h = Insert(s, { type: "frame", name: "Header", width: "fill_container", height: 56, padding: [0, "$s16"], alignItems: "center", stroke: "$ink", strokeWidth: { bottom: 1 } });
    Insert(h, { type: "text", name: "Title", content: ${JSON.stringify(name.split(" · ")[0])}, fill: "$ink", fontFamily: "Inter", fontSize: 18, fontWeight: "700", lineHeight: 1.25 });
    body = Insert(s, { type: "frame", name: "Content", width: "fill_container", height: "fill_container", layout: "vertical", gap: 12, padding: "$s16" });
    list = Insert(body, { type: "frame", name: "List", width: "fill_container", layout: "vertical" });
    for (const t of ["Alpha", "Beta", "Gamma", "Delta"]) { r = Insert(list, { type: "frame", name: "Row", width: "fill_container", height: 48, alignItems: "center" }); Insert(r, { type: "text", name: "Label", content: t, fill: "$ink", fontFamily: "Inter", fontSize: 16 }); }
    Insert(body, { type: "ref", ref: ${JSON.stringify(ids["C/Button"])}, name: "Primary", descendants: { ${labelId}: { content: "Pay now" } } });
    Insert(body, { type: "frame", name: "Secret", width: 10, height: 10, enabled: false });
    tall = Insert(body, { type: "frame", name: "Too tall", width: "fill_container", height: 900, fill: "$bg" });
    tab = Insert(s, { type: "frame", name: "Tab bar", layoutPosition: "absolute", x: 0, y: 788, width: 390, height: 56, fill: "$bg" });`);
  }
  await exec(`Insert(document, { type: "path", name: "→", x: 410, y: 400, width: 152, height: 18, viewBox: [0, 0, 152, 18], geometry: "M0 9l140 0m-10-7l10 7-10 7", stroke: "$ink", strokeWidth: 3 });
    Insert(document, { type: "text", name: "edge", x: 430, y: 360, content: "→ pay", fill: "$ink", fontFamily: "Inter", fontSize: 14 });
    Insert(document, { type: "note", name: "why", x: 0, y: -300, width: 300, height: 60, content: "Checkout must fit one screen" });
    Insert(document, { type: "text", name: "band", x: -700, y: -40, content: "FLOW 1 · BUYER", fill: "$ink", fontFamily: "Inter", fontSize: 48 });`);
  await call(client, "save", { filePath: file });
});

after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("overview: matrix with themes, flow with its label, component usage, intent note", async () => {
  const res = await call(client, "overview", { filePath: file, refresh: true });
  assert.ok(!res.isError, text(res));
  const t = text(res);
  assert.match(t, /3 screens, 2 components/);
  assert.match(t, /Themes: mode = light, dark/);
  assert.match(t, /^Home \|  \| light,dark$/m);
  assert.match(t, /^Checkout \|  \| light$/m);
  assert.match(t, /Home · light → Checkout · light "pay"/);
  assert.match(t, /C\/Button \(\w+\): 3 instances in 3 screens/);
  assert.match(t, /Checkout must fit one screen/);
});

test("overview focus lists frame ids; inspect by name resolves and reports everything an implementer needs", async () => {
  const focus = text(await call(client, "overview", { filePath: file, focus: "Checkout" }));
  const id = /Checkout · light → id (\w+)/.exec(focus)[1];
  const res = await call(client, "inspect", { filePath: file, target: "Checkout · light", flavor: "tailwind" });
  assert.ok(!res.isError, text(res));
  const t = text(res);
  assert.match(t, new RegExp(`# Checkout · light \\(${id}\\)`));
  assert.match(t, /Comes from: Home · light "pay"/);
  assert.match(t, /Components used: C\/Button ×1/);
  assert.match(t, /- top: Header — "Checkout"/);
  assert.match(t, /- bottom: Tab bar/);
  assert.match(t, /1\. List \(\w+\) — "Alpha" "Beta" "Gamma" "Delta"/);
  assert.match(t, /2\. Primary \(\w+\) — <C\/Dot> "Pay now"/, "instance content with its override");
  assert.match(t, /×3 more like Row \(content: "Beta", "Gamma", "Delta"\)/);
  assert.match(t, /Title \[text\] .*"Checkout" Inter 18 700 lh 22.5px · color \$ink\(#111111 light, #EEEEEE dark\)/);
  assert.match(t, /Primary \[frame ← C\/Button\]/);
  assert.match(t, /Too tall .*⚠ partially clipped/);
  assert.match(t, /tw: .*border-b-\[1px\]/);
  assert.doesNotMatch(t, /Secret/);
});

test("inspect resolves a dark frame's colors in its own theme", async () => {
  const t = text(await call(client, "inspect", { filePath: file, target: "Home · dark", format: "json" }));
  const body = JSON.parse(t.slice(t.indexOf("{")));
  const title = body.nodes.find((n) => n.address === "Home · dark/Header/Title");
  assert.equal(title.resolved.fill, "#EEEEEE");
  assert.ok(title.bounds.y > 0 && title.bounds.y + title.bounds.h < 56, `title sits inside the 56px header: ${JSON.stringify(title.bounds)}`);
  assert.equal(title.bounds.x, 16, "left padding from the $s16 token");
  assert.deepEqual(body.duplicateNames, ["Home · dark/Content/List/Row"]);
});

test("ambiguous names list the candidates instead of guessing", async () => {
  const res = await call(client, "inspect", { filePath: file, target: "Home" });
  assert.equal(res.isError, true);
  assert.match(text(res), /matches 2 frames/);
  assert.match(text(res), /Home · light \(390, light\) → \w+/, "each candidate shows its width and theme");
});

test("savePath writes the spec with the .pen's hash, and flags a stale previous spec", async () => {
  const spec = path.join(dir, "spec", "checkout.json");
  await call(client, "inspect", { filePath: file, target: "Checkout · light", savePath: spec });
  const saved = JSON.parse(fs.readFileSync(spec, "utf8"));
  assert.equal(saved.target.name, "Checkout · light");
  assert.match(saved.pen.sha1, /^[0-9a-f]{40}$/);
  assert.deepEqual(saved.sections.map((s) => s.name), ["List", "Primary", "Too tall"]);
  await exec(`Get(n => { if (n.name === "Checkout · light") Update(n.id, { fill: "$ink" }); return undefined; })`);
  await call(client, "save", { filePath: file });
  const again = text(await call(client, "inspect", { filePath: file, target: "Checkout · light", savePath: spec }));
  assert.match(again, /previous spec .* was stale/);
});

test("html-ref writes Pen's export with box-sizing fixed and data-pen names", async () => {
  const res = text(await call(client, "inspect", { filePath: file, target: "Checkout · light", format: "html-ref", savePath: path.join(dir, "ref", "checkout.json") }));
  const html = fs.readFileSync(path.join(dir, "ref", "checkout.html"), "utf8");
  assert.match(res, /Reference HTML written/);
  assert.doesNotMatch(html, /content-box/);
  assert.match(html, /data-pen="Header"/);
});

test("a screen added through this server shows up immediately, without a save or refresh", async () => {
  await call(client, "overview", { filePath: file }); // cache the analysis
  await exec(`Insert(document, { type: "frame", name: "Settings · light", x: 1200, y: 0, width: 390, height: 844, theme: { mode: "light" } })`);
  assert.match(text(await call(client, "overview", { filePath: file })), /^Settings \|  \| light/m);
  const res = await call(client, "inspect", { filePath: file, target: "Settings · light" });
  assert.ok(!res.isError, text(res));
});

test("unknown targets suggest the closest screens; a section id is inspected directly", async () => {
  const miss = await call(client, "inspect", { filePath: file, target: "Checkot light" });
  assert.equal(miss.isError, true);
  assert.match(text(miss), /No screen or node matches "Checkot light"/);
  assert.match(text(miss), /Checkout · light → \w+/);
  const json = text(await call(client, "inspect", { filePath: file, target: "Checkout · light", format: "json" }));
  const listId = JSON.parse(json.slice(json.indexOf("{"))).nodes.find((n) => n.name === "List").id;
  const list = await call(client, "inspect", { filePath: file, target: listId });
  assert.ok(!list.isError, text(list));
  assert.match(text(list), new RegExp(`# List \\(${listId}\\)`));
});

test("a nested instance swapped through an override reports the component actually shown", async () => {
  const star = /"C\/Star":"(\w+)"/.exec(await exec(`s = Insert(document, { type: "frame", name: "C/Star", reusable: true, x: 300, y: -600, width: 12, height: 12, fill: "$bg" }); Print(JSON.stringify({ "C/Star": s }))`))[1];
  const ids = JSON.parse(/^I (.*)$/m.exec(await exec(`const b = Get(n => n.name === "C/Button" && n.reusable ? n.id : undefined)[0]; const dot = Get(b, { depth: 1 }).children.find(c => c.name === "Dot").id; Print("I", JSON.stringify({ b, dot }))`))[1]);
  await exec(`Get(n => { if (n.name === "Checkout · light") { c = Get(n.id, n2 => n2.name === "Content" ? n2.id : undefined)[0]; Insert(c, { type: "ref", ref: ${JSON.stringify(ids.b)}, name: "Starred", descendants: { ${JSON.stringify(ids.dot)}: { type: "ref", ref: ${JSON.stringify(star)} } } }); } return undefined; })`);
  const t = text(await call(client, "inspect", { filePath: file, target: "Checkout · light" }));
  assert.match(t, /Starred \[frame ← C\/Button\]/);
  // The replacement node takes the component's name and its own id; it must still say which component it is.
  assert.match(t, /C\/Star \[frame ← C\/Star\]/);
  assert.match(t, /Starred \(\w+\) — <C\/Star> "Go"/);
});

test("a headless read-only snippet leaves the file clean", async () => {
  await call(client, "save", { filePath: file });
  await exec(`Print(Get(n => n.name))`);
  const list = JSON.parse(text(await call(client, "list_sessions", {})));
  assert.equal(list.sessions.find((s) => s.filePath === file).unsavedChanges, false);
  assert.deepEqual(list.pendingSaves, []);
});

test("savePath refuses non-json paths and files that are not specs", async () => {
  const bad = await call(client, "inspect", { filePath: file, target: "Checkout · light", savePath: path.join(dir, "notes.txt") });
  assert.match(text(bad), /must end with \.json/);
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const clobber = await call(client, "inspect", { filePath: file, target: "Checkout · light", savePath: path.join(dir, "package.json") });
  assert.match(text(clobber), /not an inspect spec; refusing/);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), "{}");
});

test("json output is capped inline; the saved spec is complete", async () => {
  const t = text(await call(client, "inspect", { filePath: file, target: "Checkout · light", format: "json", maxLines: 20, savePath: path.join(dir, "spec", "full.json") }));
  const body = JSON.parse(t.slice(t.indexOf("{")));
  assert.equal(body.nodes.length, 20);
  assert.ok(body.truncatedNodes > 0);
  assert.match(t, /nodes are not included inline: pass savePath/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "spec", "full.json"), "utf8"));
  assert.equal(saved.nodes.length, 20 + body.truncatedNodes);
});

test("html-ref goes to its own folder and never replaces a file it did not write", async () => {
  const res = text(await call(client, "inspect", { filePath: file, target: "Checkout · light", format: "html-ref" }));
  assert.match(res, /design-ref\/Checkout_light\.html/);
  fs.writeFileSync(path.join(dir, "design-ref", "Home_light.html"), "<html>mine</html>");
  const clash = await call(client, "inspect", { filePath: file, target: "Home · light", format: "html-ref" });
  assert.equal(clash.isError, true);
  assert.match(text(clash), /not written by inspect; refusing/);
  assert.equal(fs.readFileSync(path.join(dir, "design-ref", "Home_light.html"), "utf8"), "<html>mine</html>");
});

test("with autosave off: a spec of an unsaved file can be refreshed, and close_file without saving drops the cached analysis", async () => {
  const off = await connect({ home: path.join(dir, "home-off"), cwd: dir, env: { PEN_MULTI_AUTOSAVE: "0" } });
  try {
    const draft = path.join(dir, "draft.pen");
    const put = (input) => call(off, "execute", { filePath: draft, input });
    await put(`Insert(document, { type: "frame", name: "Draft · light", width: 390, height: 844, layout: "vertical" })`);
    const spec = path.join(dir, "spec", "draft.json");
    await call(off, "inspect", { filePath: draft, target: "Draft · light", savePath: spec });
    assert.equal(JSON.parse(fs.readFileSync(spec, "utf8")).pen.sha1, null, "the file is not on disk yet");
    const again = await call(off, "inspect", { filePath: draft, target: "Draft · light", savePath: spec });
    assert.ok(!again.isError, text(again));

    await call(off, "overview", { filePath: draft });
    await call(off, "close_file", { filePath: draft, save: false });
    const after = text(await call(off, "overview", { filePath: draft }));
    assert.doesNotMatch(after, /Draft/, "the dropped screen is gone from the overview");
  } finally {
    await off.close();
  }
});

test("a fresh agent's second call reuses the analysis, and inspect by id right after overview keeps the breadcrumb", async () => {
  const fresh = await connect({ home: path.join(dir, "home-fresh"), cwd: dir });
  try {
    const copy = path.join(dir, "copy.pen");
    await call(client, "save", { filePath: file });
    fs.copyFileSync(file, copy);
    const first = text(await call(fresh, "overview", { filePath: copy }));
    assert.doesNotMatch(first, /cached analysis/);
    assert.match(text(await call(fresh, "overview", { filePath: copy })), /cached analysis/);
    const id = /Checkout · light → id (\w+)/.exec(text(await call(fresh, "overview", { filePath: copy, focus: "Checkout" })))[1];
    const t = text(await call(fresh, "inspect", { filePath: copy, target: id }));
    assert.match(t, /Variants: Checkout · light/);
    assert.match(t, /Comes from: Home · light "pay"/);
  } finally {
    await fresh.close();
  }
});
