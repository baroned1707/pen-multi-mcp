#!/usr/bin/env node
// A fake pen.dev app whose documents are real: each one is a headless `pen interactive` editor,
// so execute snippets run on the real engine. The browser is simulated: import-to-canvas inserts
// a small frame tree, screenshot-to-canvas writes a PNG next to the document and inserts an
// image-filled node, the way the real app does. State: FAKE_ACTIVE_FILE ({active, open, page}).
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PenShell } from "../src/shell.js";

const stateFile = process.env.FAKE_ACTIVE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const update = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
const docFor = (filePath) => (filePath && state().open.includes(filePath) ? filePath : state().active);
const reply = (text) => ({ content: [{ type: "text", text }] });

const editors = new Map();
async function run(doc, input) {
  if (!editors.has(doc)) {
    const shell = new PenShell({ inPath: fs.existsSync(doc) && fs.statSync(doc).size ? doc : undefined, outPath: doc });
    editors.set(doc, shell.start().then(() => shell));
  }
  const res = await (await editors.get(doc)).call("execute", { input });
  if (res.error) throw new McpError(ErrorCode.InternalError, res.error);
  return res.text;
}

// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const server = new McpServer({ name: "fake-pen-app-engine", version: "0" });
server.registerTool("get_app_state", { inputSchema: {} }, async () =>
  reply(`## Canvas Editor\n\n- Currently active canvas editor: \`${state().active}\``),
);
server.registerTool("execute", { inputSchema: { filePath: z.string().optional(), input: z.string().optional() } }, async (a) =>
  reply(await run(docFor(a.filePath), a.input)),
);
server.registerTool(
  "browser",
  { inputSchema: { filePath: z.string().optional(), action: z.string(), url: z.string().optional(), target: z.string().optional(), querySelector: z.string().optional() } },
  async (a) => {
    const doc = docFor(a.filePath);
    if (a.action === "load-page") {
      update({ page: a.url });
      return reply(`Loaded ${a.url}`);
    }
    const host = new URL(state().page).host;
    if (a.action === "import-to-canvas") {
      await run(
        doc,
        `f=Insert(document,{type:"frame",name:"Imported ${host}",x:10,y:10,width:320,height:200,layout:"vertical",gap:8});` +
          `Insert(f,{type:"text",name:"Heading",content:"Hello from ${host}",fontSize:24});` +
          `r=Insert(f,{type:"frame",name:"Row",layout:"horizontal",gap:4});Insert(r,{type:"text",name:"Cell",content:"cell"})`,
      );
      return reply(`Imported the element onto the canvas as editable layers.`);
    }
    if (a.action === "screenshot-to-canvas") {
      fs.writeFileSync(path.join(path.dirname(doc), `screenshot-${host}.png`), PNG);
      await run(doc, `Insert(document,{type:"rectangle",name:"Screenshot",x:0,y:0,width:100,height:50,fill:{type:"image",url:"screenshot-${host}.png",mode:"fill"}})`);
      return reply(`Added a screenshot to the canvas.`);
    }
    return reply(`${a.action} of ${state().page}`);
  },
);
await server.connect(new StdioServerTransport());
