import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// The pen.dev desktop app's own MCP server. pen-multi runs it as a child to reach features
// only the app has (integrated browser, spawn_agents, the user's live canvas and selection).
const DEFAULT_SERVER = "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64";
const DEFAULT_SOCKET = path.join(os.homedir(), ".pencil", "socket", "pencil-desktop.sock");

export const appConfig = {
  enabled: process.env.PEN_MULTI_APP !== "0",
  server: process.env.PEN_MULTI_APP_SERVER ?? DEFAULT_SERVER,
  agent: process.env.PEN_MULTI_APP_AGENT ?? "claudeCodeCLI",
  // "none" skips the socket probe (used by tests with a fake app server).
  socket: process.env.PEN_MULTI_APP_SOCKET ?? DEFAULT_SOCKET,
};

export class AppUnavailableError extends Error {}

const ACTIVE = /Currently active canvas editor: `([^`]+)`/;

export class AppBridge {
  constructor(resolvePath) {
    this.resolvePath = resolvePath;
    this.client = null;
    this.connecting = null;
  }

  /** Whether the desktop app is running and reachable right now. */
  async available() {
    if (!appConfig.enabled || !fs.existsSync(appConfig.server)) return false;
    if (appConfig.socket === "none") return true;
    return new Promise((resolve) => {
      const sock = net.connect(appConfig.socket);
      const done = (ok) => {
        sock.destroy();
        resolve(ok);
      };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.setTimeout(1000, () => done(false));
    });
  }

  async call(name, args = {}) {
    if (!(await this.available())) {
      throw new AppUnavailableError(
        `${name} needs the pen.dev desktop app, which is not running${appConfig.enabled ? "" : " (disabled by PEN_MULTI_APP=0)"}.`,
      );
    }
    const client = await this.#client();
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
      if (!res.isError) return res;
      return { ...res, content: res.content.map((c) => (c.type === "text" ? { ...c, text: stripCode(c.text) } : c)) };
    } catch (err) {
      // The app reports tool failures (e.g. a snippet error with its editId) as JSON-RPC errors.
      // Hand those back as a normal error result; only a broken connection needs a new client.
      if (err instanceof McpError && err.code === ErrorCode.InternalError) {
        return { content: [{ type: "text", text: stripCode(err.message) }], isError: true };
      }
      this.#reset();
      throw new Error(`pen.dev app call ${name} failed: ${err.message}`);
    }
  }

  /** Resolved path of the document in the app's active tab, or null. */
  async activeFile() {
    if (!(await this.available())) return null;
    const res = await this.call("get_app_state");
    const match = ACTIVE.exec(textOf(res));
    return match ? this.resolvePath(match[1]) : null;
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  async #client() {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ name: "pen-multi", version: "0.2.0" });
      const transport = new StdioClientTransport({
        command: appConfig.server,
        args: ["--app", "desktop", "--agent", appConfig.agent, "--enable_spawn_agents"],
        env: process.env, // the SDK otherwise passes only a minimal default environment
        stderr: "ignore",
      });
      await client.connect(transport);
      client.onclose = () => this.#reset();
      this.client = client;
      return client;
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  #reset() {
    const stale = this.client;
    this.client = null;
    stale?.close().catch(() => {});
  }
}

const stripCode = (text) => text.replace(/^MCP error -?\d+: /, "");

export const textOf = (res) => (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
