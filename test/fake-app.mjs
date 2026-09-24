#!/usr/bin/env node
// Stand-in for the pen.dev desktop app's MCP server. The active document is read from the file
// named by FAKE_ACTIVE_FILE on every call, so tests can switch tabs. Like the real server, a
// filePath that is not open falls back to the active document; OPEN lists the open documents.
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const state = () => JSON.parse(fs.readFileSync(process.env.FAKE_ACTIVE_FILE, "utf8"));
const docFor = (filePath) => {
  const { active, open = [] } = state();
  return filePath && open.includes(filePath) ? filePath : active;
};
const reply = (text) => ({ content: [{ type: "text", text }] });

const server = new McpServer({ name: "fake-pen-app", version: "0" });
server.registerTool("get_app_state", { inputSchema: {} }, async () => {
  const { active } = state();
  return reply(active ? `## Canvas Editor\n\n- Currently active canvas editor: \`${active}\`\n- Selected nodes: \`sel1\`` : "No editor");
});
server.registerTool("execute", { inputSchema: { filePath: z.string().optional(), input: z.string().optional() } }, async (a) => {
  // The real server reports snippet failures as JSON-RPC internal errors, not isError results.
  if (a.input === "FAIL") throw new McpError(ErrorCode.InternalError, 'Failed to execute: SyntaxError\n- `editId`: "E1"');
  return reply(`APP-EXECUTE doc=${docFor(a.filePath)} input=${a.input}`);
});
server.registerTool(
  "browser",
  { inputSchema: { filePath: z.string().optional(), action: z.string(), url: z.string().optional() } },
  async (a) => reply(`APP-BROWSER doc=${docFor(a.filePath)} action=${a.action} url=${a.url ?? ""}`),
);
server.registerTool(
  "spawn_agents",
  { inputSchema: { filePath: z.string().optional(), config: z.array(z.any()) } },
  async (a) => reply(`APP-SPAWN doc=${docFor(a.filePath)} agents=${a.config.length}`),
);
await server.connect(new StdioServerTransport());
