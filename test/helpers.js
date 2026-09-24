import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

/** Starts one pen-multi server, the way one agent session would: its own process and working directory. */
export async function connect({ home, cwd, env = {} }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd,
    env: { ...process.env, PEN_MULTI_HOME: home, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  client.pid = transport.pid;
  return client;
}

export const text = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
// Generous client timeout: on a loaded machine one editor can take 30 s or more to start.
export const call = (client, name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
export const countNodes = `const r=Get((n,c)=>c.parentCtx?undefined:n.name);Print("COUNT",r.length,JSON.stringify(r))`;
export const rect = (name) =>
  `Insert(document,{type:"rectangle",name:${JSON.stringify(name)},x:0,y:0,width:40,height:40,fill:"#E5484D"})`;
