#!/usr/bin/env node
// Stand-in for the pen.dev desktop app's MCP server. State lives in the JSON file named by
// FAKE_ACTIVE_FILE ({active, open, page}), shared by every pen-multi process in a test, like
// the one real app. Like the real server, a filePath that is not open falls back to the
// active document. The integrated browser's page is shared too.
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const stateFile = process.env.FAKE_ACTIVE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const update = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
const docFor = (filePath) => {
  const { active, open = [] } = state();
  return filePath && open.includes(filePath) ? filePath : active;
};
const reply = (text) => ({ content: [{ type: "text", text }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = new McpServer({ name: "fake-pen-app", version: "0" });

// Like the real server, the first call on a new connection fails, whatever the tool.
let warmedUp = false;
const firstCallFails = (handler) => async (args) => {
  if (!warmedUp) {
    warmedUp = true;
    return { content: [{ type: "text", text: "failed to execute tool call. you are probably referencing the wrong .pen file" }], isError: true };
  }
  return handler(args);
};
server.registerTool("get_app_state", { inputSchema: {} }, firstCallFails(async () => {
  update({ stateCalls: (state().stateCalls ?? 0) + 1 });
  const { active } = state();
  return reply(active ? `## Canvas Editor\n\n- Currently active canvas editor: \`${active}\`\n- Selected nodes: \`sel1\`` : "No editor");
}));
server.registerTool("execute", { inputSchema: { filePath: z.string().optional(), input: z.string().optional() } }, firstCallFails(async (a) => {
  // The real server reports snippet failures as JSON-RPC internal errors, not isError results.
  if (a.input === "FAIL") throw new McpError(ErrorCode.InternalError, 'Failed to execute: SyntaxError\n- `editId`: "E1"');
  const slow = /SLOW:(\d+)/.exec(a.input ?? "");
  if (slow) await sleep(Number(slow[1])); // a busy app
  return reply(`APP-EXECUTE doc=${docFor(a.filePath)} input=${a.input}`);
}));
server.registerTool(
  "browser",
  {
    inputSchema: {
      filePath: z.string().optional(),
      action: z.string(),
      url: z.string().optional(),
      nodeId: z.string().optional(),
      target: z.string().optional(),
      querySelector: z.string().optional(),
    },
  },
  firstCallFails(async (a) => {
    const doc = docFor(a.filePath);
    const { ready = [] } = state();
    if (!ready.includes(doc)) {
      // A window the app has just opened needs a moment before its browser answers.
      update({ ready: [...ready, doc] });
      return { content: [{ type: "text", text: "IPC request \"browser\" failed. Error: IPCError: No handler found for method 'browser'" }], isError: true };
    }
    if (a.action === "load-page") {
      await sleep(Number(process.env.FAKE_LOAD_MS ?? 0)); // lets another agent's load interleave without a lock
      update({ page: a.url });
    }
    return reply(`APP-BROWSER doc=${docFor(a.filePath)} action=${a.action} page=${state().page ?? ""}`);
  }),
);
server.registerTool(
  "spawn_agents",
  { inputSchema: { filePath: z.string().optional(), config: z.array(z.any()) } },
  firstCallFails(async (a) => reply(`APP-SPAWN doc=${docFor(a.filePath)} agents=${a.config.length}`)),
);
await server.connect(new StdioServerTransport());
