// The brief's rules in numbers: parsed from ```pen-rules blocks, checked on the design (lint) and on
// the code (verify), cited by their ids; the digest keeps rule labels and references.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { anyGlob, parseRules, references, rulesLine } from "../src/context/rules.js";
import { digestOf } from "../src/context/brief.js";
import { buildModel } from "../src/design/model.js";
import { lintBrief, marginAt } from "../src/lint/brief.js";
import { briefCodeFindings } from "../src/verify/brief.js";
import { call, connect, text } from "./helpers.js";

const BRIEF = `# Brief

## Visual direction
Follow the guideline. See the \`guide\` skill and \`docs/guide.md\`.

## The rules
**R1. Four text styles.** Large Title, Body, Subhead, Footnote.

\`\`\`pen-rules
{ "type": { "id": "R1", "sizes": [34, 17, 15, 13], "maxStyles": 3, "exempt": [34], "families": ["Inter"], "ignore": ["Chart*"] },
  "size": { "id": "T", "minTarget": 44 },
  "rows": { "id": "R2", "heights": [44], "components": ["Row"] },
  "space": { "id": "R5", "sideMargin": { "0": 16, "720": 20 }, "scale": [8, 16] },
  "action": { "id": "R7", "maxProminent": 1, "prominentFills": ["$accent"] },
  "color": { "id": "C", "tokensOnly": true, "text": ["$fg"] } }
\`\`\`

**R2. A row is one line.** Rows are 44 tall.
`;

test("pen-rules blocks are parsed and merged; mistakes are reported, not ignored", () => {
  const { rules, errors, blocks } = parseRules(BRIEF);
  assert.equal(blocks, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(rules.type.sizes, [34, 17, 15, 13]);
  assert.equal(rules.rows.id, "R2");
  const bad = parseRules("```pen-rules\n{ \"type\": { \"sizes\": [\"x\"], \"colour\": 1 }, \"layout\": {} }\n```\n```pen-rules\n{ nope\n```\n```pen-rules\n{ \"size\": { \"minTarget\": 40 } }\n```");
  assert.equal(bad.blocks, 3);
  assert.equal(bad.rules.size.minTarget, 40); // the good block still counts
  assert.equal(bad.errors.length, 4, bad.errors.join("\n"));
  assert.match(bad.errors.join("\n"), /type\.sizes: \["x"\] is not valid[\s\S]*unknown key "colour"[\s\S]*unknown group "layout"[\s\S]*block 2 \(line 4\) is not JSON/);
  assert.match(rulesLine(rules), /^R1 type sizes 34\/17\/15\/13, ≤ 3 styles, fonts Inter · T targets ≥ 44 · R2 rows 44 \(Row\) · R5 margins 16, 20 from 720 spacing 8\/16 · R7 ≤ 1 prominent action · C tokens only, text \$fg$/);
  assert.equal(anyGlob(["TabBar*", "$v-*"])("tabbar5"), true);
  assert.equal(anyGlob(["$v-*"])("$v-buy"), true);
  assert.equal(anyGlob(["$v-*"])("$fg"), false);
});

test("the digest keeps rule labels and skips code blocks; references are the existing paths and skills", () => {
  const d = digestOf(BRIEF);
  assert.ok(d.includes("  R1. Four text styles."), d.join("\n"));
  assert.ok(d.includes("  R2. A row is one line."));
  assert.ok(!d.some((l) => l.includes("pen-rules") || l.includes('"type"')), d.join("\n"));
  assert.deepEqual(digestOf("## Setup\n```sh\n# install\nnpm i\n```\nRun it."), ["## Setup", "Run it."]);
  const have = new Set([".claude/skills/guide", "docs/guide.md"]);
  assert.deepEqual(references(BRIEF, (p) => have.has(p)).sort(), [".claude/skills/guide", "docs/guide.md"]);
  assert.deepEqual(references("see `docs/missing.md`", () => false), []);
  assert.equal(marginAt({ 0: 16, 720: 20 }, 390), 16);
  assert.equal(marginAt({ 0: 16, 720: 20 }, 834), 20);
});

// A design model built from raw nodes (bounds parent-relative, as the engine gives them).
const model = (nodes, extra = {}) => buildModel({ root: "s", nodes: nodes.map((n) => ({ bounds: { x: 0, y: 0, width: 10, height: 10 }, ...n })), comps: { row: "Row", btn: "Button" }, variables: { accent: { type: "color", value: "#2563EB" }, fg: { type: "color", value: "#111111" }, muted: { type: "color", value: "#666666" } }, ...extra });
const txt = (id, parent, fontSize, x = 16, more = {}) => ({ id, parent, type: "text", name: id, content: id, fontSize, fontFamily: "Inter", fill: "$fg", bounds: { x, y: 0, width: 100, height: 20 }, ...more });

test("lint brief: sizes, styles (exempt ones apart), fonts, targets, rows, margins, spacing, prominent actions, colors", () => {
  const { rules } = parseRules(BRIEF);
  const m = model(
    [
      { id: "s", type: "frame", name: "Home", bounds: { x: 0, y: 0, width: 390, height: 844 }, layout: "vertical" },
      { id: "sec", parent: "s", type: "frame", name: "List", layout: "vertical", gap: 12, bounds: { x: 0, y: 0, width: 390, height: 400 } },
      txt("big", "sec", 34),
      txt("a", "sec", 17),
      txt("b", "sec", 15),
      txt("c", "sec", 13),
      txt("d", "sec", 11), // off the ramp, a fourth counted style
      txt("mono", "sec", 13, 16, { fontFamily: "Courier" }),
      txt("muted", "sec", 13, 16, { fill: "$muted" }),
      { id: "chart", parent: "sec", type: "frame", name: "Chart area", bounds: { x: 16, y: 0, width: 300, height: 100 } },
      txt("tick", "chart", 9), // ignored: inside Chart*
      { id: "r1", parent: "sec", type: "frame", name: "Row", bounds: { x: 12, y: 40, width: 360, height: 52 } },
      { id: "b1", parent: "sec", type: "frame", name: "Buy button", fill: "$accent", bounds: { x: 16, y: 100, width: 100, height: 36 } },
      txt("bl", "b1", 17, 8),
      { id: "b2", parent: "sec", type: "frame", name: "Sell button", fill: "#2563EB", bounds: { x: 16, y: 140, width: 100, height: 44 } },
      txt("sl", "b2", 17, 8),
    ],
    { refs: { r1: ["row", []] } },
  );
  const found = lintBrief(m, rules);
  const msgs = found.map((f) => f.message);
  const has = (re) => assert.ok(msgs.some((x) => re.test(x)), `${re}\n${msgs.join("\n")}`);
  has(/^R1: font size 11 not in 34\/17\/15\/13 — 1 node/);
  has(/^R1: 4 text styles \(max 3\): 17 ×3, 13 ×3, 15 ×1, 11 ×1\./);
  has(/^R1: fonts not in Inter — 1 node, e\.g\. Courier/);
  has(/^T: tap targets under 44×44 — 1 node, e\.g\. 100×36/);
  has(/^R2: row heights not 44 — 1 node, e\.g\. 52 Row/);
  has(/^R5: gap\/padding 12 not in 8\/16/);
  has(/^R7: 2 prominent actions \(max 1\)/);
  has(/^C: raw colors instead of tokens — 1 node, e\.g\. #2563EB/);
  has(/^C: text colors outside \$fg — 1 node, e\.g\. \$muted/);
  assert.ok(!msgs.some((x) => /9/.test(x.split("—")[0])), "the chart's tick is ignored");
  assert.equal(found.length, 9, msgs.join("\n"));
  assert.deepEqual(lintBrief(m, {}), []);
});

test("lint brief margins: measured in the content column (beside a sidebar), reported when most sections agree", () => {
  const { rules } = parseRules(BRIEF);
  const screen = (w, insets) =>
    model([
      { id: "s", type: "frame", name: "Home", bounds: { x: 0, y: 0, width: w, height: 800 }, layout: "horizontal" },
      { id: "side", parent: "s", type: "frame", name: "Sidebar", fill: "#EEEEEE", bounds: { x: 0, y: 0, width: 240, height: 800 } },
      { id: "main", parent: "s", type: "frame", name: "Main", layout: "vertical", bounds: { x: 240, y: 0, width: w - 240, height: 800 } },
      ...insets.map((x, k) => ({ id: `sec${k}`, parent: "main", type: "frame", name: `Group ${k}`, bounds: { x: 0, y: k * 100, width: w - 240, height: 90 } })),
      ...insets.map((x, k) => txt(`t${k}`, `sec${k}`, 17, x)),
    ]);
  const margin = (m) => lintBrief(m, { space: rules.space }).filter((f) => /side margin/.test(f.message));
  assert.match(margin(screen(1440, [16, 16, 16]))[0]?.message ?? "", /^R5: side margin at 1440 should be 20; 3 of 3 sections start at 16/);
  assert.deepEqual(margin(screen(1440, [20, 20, 20])), []);
  assert.deepEqual(margin(screen(1440, [20, 20, 0])), []); // one full-bleed chart is not the margin

  // Found on trading-agent: split panes, a nav bar inside a pane, a numbered tab bar, a centered card.
  const split = (inset) =>
    model([
      { id: "s", type: "frame", name: "Shell", bounds: { x: 0, y: 0, width: 834, height: 800 }, layout: "vertical" },
      { id: "split", parent: "s", type: "frame", name: "Split", layout: "horizontal", bounds: { x: 0, y: 0, width: 834, height: 720 } },
      { id: "list", parent: "split", type: "frame", name: "List pane", fill: "#FFFFFF", layout: "vertical", bounds: { x: 0, y: 0, width: 320, height: 720 } },
      { id: "nav", parent: "list", type: "frame", name: "NavBar", bounds: { x: 0, y: 0, width: 320, height: 44 } },
      txt("back", "nav", 17, 8),
      { id: "rows", parent: "list", type: "frame", name: "Rows", bounds: { x: 0, y: 44, width: 320, height: 600 } },
      txt("t0", "rows", 17, inset),
      { id: "detail", parent: "split", type: "frame", name: "Detail pane", layout: "vertical", bounds: { x: 320, y: 0, width: 514, height: 720 } },
      txt("t1", "detail", 17, inset),
      { id: "tabs", parent: "s", type: "frame", name: "TabBar5", fill: "#EEEEEE", bounds: { x: 0, y: 720, width: 834, height: 80 } },
      txt("t2", "tabs", 11, 60),
    ]);
  assert.deepEqual(margin(split(20)), []);
  assert.match(margin(split(16))[0]?.message ?? "", /^R5: side margin at 834 should be 20; 2 of 2 sections start at 16 \(/);
  const nested = (inset) => model([
    { id: "s", type: "frame", name: "Trust", bounds: { x: 0, y: 0, width: 834, height: 800 }, layout: "vertical" },
    { id: "main", parent: "s", type: "frame", name: "Main", layout: "vertical", bounds: { x: 0, y: 0, width: 834, height: 800 } },
    { id: "col", parent: "main", type: "frame", name: "Column", bounds: { x: 0, y: 0, width: 834, height: 700 } },
    txt("t0", "col", 17, inset),
    { id: "tabs", parent: "main", type: "frame", name: "TabBar5", bounds: { x: 0, y: 700, width: 834, height: 100 } },
    txt("t1", "tabs", 11, 60),
  ]);
  // A tab bar inside the content is not a section at the margin.
  assert.deepEqual(margin(nested(20)), []);
  assert.match(margin(nested(16))[0]?.message ?? "", /1 of 1 sections start at 16 \(e\.g\. Column\)/);
  const card = model([
    { id: "s", type: "frame", name: "Error", bounds: { x: 0, y: 0, width: 834, height: 800 }, layout: "vertical" },
    { id: "card", parent: "s", type: "frame", name: "Card", layout: "vertical", bounds: { x: 237, y: 200, width: 360, height: 300 } },
    { id: "glyph", parent: "card", type: "frame", name: "Glyph", fill: "#EEEEEE", bounds: { x: 0, y: 0, width: 56, height: 56 } },
    txt("t0", "card", 22, 0, { bounds: { x: 0, y: 70, width: 360, height: 30 } }),
  ]);
  assert.deepEqual(margin(card), []); // centered content is not at a margin
});

test("verify brief: only what the code chose — values shared with the design are the design's", () => {
  const { rules } = parseRules(BRIEF);
  const design = {
    frame: { fill: "#FFFFFF" },
    nodes: [
      { id: "t1", kind: "text", fontSize: 11, box: { x: 16, y: 0, w: 50, h: 20 }, color: "#111111" },
      { id: "r", kind: "instance", component: "Row", box: { x: 16, y: 40, w: 358, h: 44 } },
    ],
  };
  const el = (i, more) => ({ i, box: { x: 16, y: 0, w: 50, h: 20 }, ...more });
  const snapshot = {
    viewport: { w: 390, h: 844 },
    elements: [
      el(0, { text: "Shared", fontSize: 11, fontFamily: "Inter", fg: "rgba(17, 17, 17, 1)", textBox: { x: 16, y: 0, w: 50, h: 20 } }),
      el(1, { text: "Own", fontSize: 14, fontFamily: "Roboto", fg: "rgba(255, 0, 0, 1)", textBox: { x: 10, y: 30, w: 50, h: 20 } }),
      el(2, { tag: "button", box: { x: 16, y: 60, w: 30, h: 30 } }),
      el(3, { box: { x: 16, y: 40, w: 358, h: 50 } }),
      el(4, { text: "Chart label", marker: "Chart/Tick", fontSize: 9, fontFamily: "Inter", fg: "rgba(17, 17, 17, 1)", textBox: { x: 20, y: 0, w: 5, h: 5 } }),
    ],
  };
  const lines = briefCodeFindings(snapshot, rules, { pairs: [["t1", snapshot.elements[0]], ["r", snapshot.elements[3]]], design, variables: { fg: { type: "color", value: "#111111" } } });
  const all = lines.join("\n");
  assert.match(all, /^- R1: font sizes not in 34\/17\/15\/13 — 1 element, e\.g\. 14 /m);
  assert.match(all, /^- R1: fonts not in Inter — 1 element, e\.g\. Roboto/m);
  assert.match(all, /^- T: tap targets under 44×44 — 1 element, e\.g\. 30×30 button/m);
  assert.match(all, /^- R2: row heights not 44 — 1 element, e\.g\. 50/m);
  assert.match(all, /^- R5: text starts 10 from the edge at 390 \(side margin 16\)\./m);
  assert.match(all, /^- C: colors that are no token's value — 1 element, e\.g\. text #FF0000/m);
  assert.ok(!/Shared|Chart label/.test(all), all); // the design's own 11, and the ignored chart
});

// End to end: brief in the project, lint on the design, verify on a page, project_context, doctor.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-rules-")));
const file = path.join(dir, "app.pen");
let client;

before(async () => {
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" } });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "design"));
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "guide.md"), "guide v1\n");
  fs.writeFileSync(path.join(dir, "design", "BRIEF.md"), BRIEF);
  const res = await call(client, "execute", {
    filePath: file,
    input: `SetVariables({ fg: { type: "color", value: "#111111" }, accent: { type: "color", value: "#2563EB" } });
    const s = Insert(document, { type: "frame", name: "Home · 390", x: 0, y: 0, width: 390, height: 400, layout: "vertical", gap: 8, padding: 16, fill: "#FFFFFF" });
    Insert(s, { type: "text", name: "Title", content: "Welcome", fill: "$fg", fontFamily: "Inter", fontSize: 18 });
    Insert(s, { type: "text", name: "Body", content: "Hello there", fill: "$fg", fontFamily: "Inter", fontSize: 17 });`,
  });
  assert.ok(!res.isError, text(res));
  fs.writeFileSync(path.join(dir, "home.html"), `<!doctype html><style>body{margin:0;padding:16px;background:#fff;font-family:Inter,sans-serif;color:#111}</style><div data-pen="Title" style="font-size:18px;line-height:22px">Welcome</div><div data-pen="Body" style="font-size:17px;margin-top:8px">Hello there</div><div style="font-size:14px;color:#c00">Own note</div>`);
});

after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lint cites the brief's rules on the design; verify lists what the code broke apart from the verdict", async () => {
  const l = await call(client, "lint", { filePath: file, rules: ["brief"] });
  assert.match(text(l), /brief · Home · 390 · .*R1: font size 18 not in 34\/17\/15\/13/, text(l));
  const v = await call(client, "verify", { filePath: file, target: "Home · 390", source: { kind: "web", url: `file://${path.join(dir, "home.html")}` }, crops: 0 });
  const t = text(v);
  const part = t.split("## Brief rules (design/BRIEF.md; not part of the verdict)")[1] ?? "";
  assert.match(part, /- R1: font sizes not in 34\/17\/15\/13 — 1 element, e\.g\. 14 /, t);
  assert.ok(!/ 18 /.test(part.split("\n")[1] ?? ""), part); // 18 is the design's, lint reports it
  assert.match(part, /- C: colors that are no token's value — 1 element, e\.g\. text #CC0000/);
});

test("project_context shows the rules and references; a changed reference marks the brief stale; doctor checks the block", async () => {
  const stamp = await call(client, "project_context", { filePath: file, action: "stamp", note: false });
  assert.ok(!stamp.isError, text(stamp));
  let t = text(await call(client, "project_context", { filePath: file }));
  assert.match(t, /R1\. Four text styles\./);
  assert.match(t, /Rules checked by lint \(design\) and verify \(code\): R1 type sizes 34\/17\/15\/13/);
  assert.match(t, /References \(read them with the brief\): docs\/guide\.md/);
  assert.match(t, /nothing structural changed/);
  fs.writeFileSync(path.join(dir, "docs", "guide.md"), "guide v2\n");
  t = text(await call(client, "project_context", { filePath: file }));
  assert.match(t, /possibly out of date[\s\S]*sources changed: docs\/guide\.md/, t);
  fs.writeFileSync(path.join(dir, "design", "BRIEF.md"), BRIEF.replace('"minTarget": 44', '"minTarget": 44, "maxTarget": 9'));
  const d = text(await call(client, "doctor", { filePath: file }));
  assert.match(d, /design\/BRIEF\.md: pen-rules size: unknown key "maxTarget"/, d);
});
