// MCP prompts: listed by the server, with the skill's own text.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { connect } from "./helpers.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pen-multi-prompts-")));
let client;
after(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the server lists the design ↔ code prompts and fills in the file and screen", async () => {
  client = await connect({ home: path.join(dir, "home"), cwd: dir, env: { PEN_MULTI_PREWARM: "0" } });
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["design-from-code", "port-design", "sync-check"]);
  const p = await client.getPrompt({ name: "port-design", arguments: { filePath: "app.pen", screen: "Checkout" } });
  const t = p.messages[0].content.text;
  assert.match(t, /# pen-port: implement a design until it matches/);
  assert.match(t, /The design: app\.pen\. Only the screen "Checkout"\./);
});

test("skills/pen-port/SKILL.md is the port-design prompt with a skill header", () => {
  const skill = fs.readFileSync(new URL("../skills/pen-port/SKILL.md", import.meta.url), "utf8");
  const prompt = fs.readFileSync(new URL("../prompts/port-design.md", import.meta.url), "utf8");
  assert.equal(skill.split("---\n", 3)[2].replace(/^\n+/, ""), prompt, "edit prompts/port-design.md and copy it into the skill");
});
