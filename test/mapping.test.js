// Design ↔ code mapping: markers found in any language, tokens and components derived from code,
// .pen-multi.json overrides, and what is missing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { componentMap, locate, scanMarkers, tokenMap } from "../src/mapping/index.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-mapping-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};
write("web/Button.tsx", `import x from "y";\n\nexport function Button({ label }) {\n  return <button data-pen="GmCFh" className="btn">{label}</button>;\n}\n`);
write("web/Home.tsx", `export default function Home() {\n  return <main data-pen="Home/Header/Title">\n    <p data-pen={row.id}>dyn</p>\n  </main>;\n}\n`);
write("app/lib/card.dart", `class ProfileCard extends StatelessWidget {\n  Widget build(c) => Container(key: const Key('pen:Card'));\n}\n`);
write("ios/Chip.swift", `struct Chip: View {\n  var body: some View { Text("x").accessibilityIdentifier("pen:C/Chip") }\n}\n`);
write("site/index.html", `<div data-pen='Footer'></div>\n`);
write("node_modules/lib/x.js", `const a = "pen:Ignored";\n`);
write("build/out.js", `const a = "pen:Built";\n`);
write("design-ref/Home.html", `<div data-pen="Exported"></div>\n`);
write(".gitignore", "build/\n");
execFileSync("git", ["init", "-q"], { cwd: dir });

test("markers are found in any language, with file:line; ignored and vendored files are skipped", () => {
  const idx = scanMarkers(dir);
  assert.deepEqual(idx.markers.get("GmCFh"), [{ file: "web/Button.tsx", line: 4 }]);
  assert.deepEqual(idx.markers.get("Card"), [{ file: "app/lib/card.dart", line: 2 }]);
  assert.deepEqual(idx.markers.get("C/Chip"), [{ file: "ios/Chip.swift", line: 2 }]);
  assert.deepEqual(idx.markers.get("Footer"), [{ file: "site/index.html", line: 1 }]);
  assert.ok(!idx.markers.has("Ignored") && !idx.markers.has("Built") && !idx.markers.has("Exported"), "node_modules, .gitignore'd files and pen-multi's own exports are skipped");
  assert.deepEqual(idx.dynamic, [{ file: "web/Home.tsx", line: 3 }]);
});

test("locate: by id, full address, address suffix, unique name; inside an instance → the component's file", () => {
  const idx = scanMarkers(dir);
  assert.deepEqual(locate({ id: "GmCFh", address: "C/Nut/Chinh", name: "C/Nut/Chinh" }, idx), { file: "web/Button.tsx", line: 4, how: "id" });
  assert.deepEqual(locate({ id: "t1", address: "Home/Header/Title", name: "Title" }, idx), { file: "web/Home.tsx", line: 2, how: "address" });
  assert.deepEqual(locate({ id: "c9", address: "Profile/Body/Card", name: "Card" }, idx), { file: "app/lib/card.dart", line: 2, how: "address" });
  const inInstance = locate({ id: "n5", address: "Home/Primary/Label", name: "Label", instanceOf: { id: "GmCFh", name: "C/Nut/Chinh" } }, idx);
  assert.deepEqual(inInstance, { file: "web/Button.tsx", line: 4, how: "component" });
  const none = locate({ id: "zz", address: "Home/Other", name: "Other" }, idx);
  assert.equal(none.file, undefined);
  assert.match(none.reason, /no static marker; 1 computed marker/);
});

test("components: derived from markers on definitions, with the declared name; overrides win", () => {
  const idx = scanMarkers(dir);
  const comps = [{ id: "GmCFh", name: "C/Nut/Chinh", instances: 9 }, { id: "Ch1", name: "C/Chip", instances: 4 }, { id: "Nm", name: "C/Nav", instances: 12 }];
  const m = componentMap(comps, idx, { Nm: { code: "BottomNav", file: "web/Nav.tsx" } }, dir);
  assert.deepEqual(m.get("GmCFh"), { code: "Button", file: "web/Button.tsx", line: 4, source: "marker" });
  assert.deepEqual(m.get("Ch1"), { code: "Chip", file: "ios/Chip.swift", line: 2, source: "marker" });
  assert.equal(m.get("Nm").code, "BottomNav");
  assert.match(m.get("Nm").problem, /web\/Nav\.tsx does not exist/);
  assert.deepEqual(m.unmapped, []);
  const m2 = componentMap([{ id: "X", name: "C/Card", instances: 3 }, { id: "Y", name: "C/Big", instances: 30 }], idx, {}, dir);
  assert.deepEqual(m2.unmapped.map((c) => c.name), ["C/Big", "C/Card"], "most used first");
});

test("tokens: by name, then by a unique value; ambiguous values stay unmapped; overrides win", () => {
  const variables = {
    accent: { type: "color", value: [{ value: "#1A56DB", theme: { mode: "light" } }, { value: "#7BA3F5", theme: { mode: "dark" } }] },
    "chu-than": { type: "number", value: 16 },
    ink: { type: "color", value: "#141416" },
    hairline: { type: "color", value: "#E3E5E9" },
    s4: { type: "number", value: 4 },
  };
  const css = `:root { --accent: #1a56db; --text-body: 16px; --gray-900: #141416; --line-a: #E3E5E9; --line-b: #e3e5e9; }\n.dark { --accent: #7BA3F5; }`;
  const m = tokenMap(variables, { mode: ["light", "dark"] }, css, "tokens.css", { s4: "--space-1" });
  assert.equal(m.get("$accent"), "--accent");
  assert.equal(m.get("$chu-than"), "--text-body");
  assert.equal(m.get("$ink"), "--gray-900");
  assert.equal(m.get("$hairline"), undefined, "two code tokens share the value");
  assert.equal(m.get("$s4"), "--space-1");
  assert.deepEqual(m.ambiguous, [{ token: "$hairline", candidates: ["--line-a", "--line-b"] }]);
});

test("tokens: a code value in rem or % is not the same as the design's number", () => {
  const m = tokenMap({ "stroke-thin": { type: "number", value: 1 }, gap: { type: "number", value: 8 } }, {}, `:root { --space-4: 1rem; --half: 1%; --gap-sm: 8px; }`, "t.css");
  assert.equal(m.get("$stroke-thin"), undefined);
  assert.equal(m.get("$gap"), "--gap-sm");
});

test("locate: a marker in several files resolves to the file preferred for this screen", () => {
  write("web/Settings.tsx", `export function Settings() {\n  return <h1 data-pen="Home/Header/Title">Settings</h1>;\n}\n`);
  const idx = scanMarkers(dir);
  const node = { id: "t9", address: "Home/Header/Title", name: "Title" };
  assert.equal(locate(node, idx).also, 1, "the other place is counted");
  assert.equal(locate(node, idx, { prefer: new Map([["web/Settings.tsx", 5]]) }).file, "web/Settings.tsx");
  assert.equal(locate(node, idx, { prefer: new Map([["web/Home.tsx", 5]]) }).file, "web/Home.tsx");
});
