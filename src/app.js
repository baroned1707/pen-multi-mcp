import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { resolveCliEntry, stripAnsi } from "./shell.js";
import { inAppCall } from "./calllog.js";

// The pen.dev desktop app's own MCP server. pen-multi runs it as a child to reach features
// only the app has (integrated browser, spawn_agents, the user's live canvas and selection).
const DEFAULT_SERVER = "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64";
const DEFAULT_SOCKET = path.join(os.homedir(), ".pencil", "socket", "pencil-desktop.sock");

const envJson = (name, fallback) => {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : fallback;
  } catch {
    return fallback;
  }
};

export const appConfig = {
  home: process.env.PEN_MULTI_HOME ?? path.join(os.homedir(), ".pen-multi"),
  enabled: process.env.PEN_MULTI_APP !== "0",
  server: process.env.PEN_MULTI_APP_SERVER ?? DEFAULT_SERVER,
  agent: process.env.PEN_MULTI_APP_AGENT ?? "claudeCodeCLI",
  // "none" skips the socket probe (used by tests with a fake app server).
  socket: process.env.PEN_MULTI_APP_SOCKET ?? DEFAULT_SOCKET,
  // Opens a document in the app WITHOUT bringing the app to the front (-g).
  openCommand: envJson("PEN_MULTI_APP_OPEN_CMD", ["open", "-g", "-a", "Pen"]),
  openTimeoutMs: Number(process.env.PEN_MULTI_APP_OPEN_TIMEOUT_MS ?? 90_000),
  stateTtlMs: Number(process.env.PEN_MULTI_APP_STATE_TTL_MS ?? 2000),
  // Test hook: a JSON file listing the documents open in the app, instead of reading `ps`.
  docsFile: process.env.PEN_MULTI_APP_DOCS_FILE,
  // "0" skips macOS UI scripting (hiding Pen, moving the workbench window); used by tests.
  ui: process.env.PEN_MULTI_APP_UI !== "0",
  workbench: process.env.PEN_MULTI_WORKBENCH ?? path.join(os.homedir(), ".pen-multi", "workbench", "workbench.pen"),
};

const osa = (script) =>
  new Promise((resolve) =>
    execFile("osascript", ["-e", script], { timeout: 10_000 }, (err, out) => resolve(err ? null : out.trim())),
  );

export class AppUnavailableError extends Error {}

const ACTIVE = /Currently active canvas editor: `([^`]+)`/;
const stripCode = (text) => text.replace(/^MCP error -?\d+: /, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const textOf = (res) => (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

export class AppBridge {
  constructor(resolvePath) {
    this.resolvePath = resolvePath;
    this.client = null;
    this.connecting = null;
    this.saving = new Map(); // file -> queue of saves, so saves of one document never overlap
    this.activeCache = null; // { file, at }
    this.activeInFlight = null;
    this.windowsInFlight = null;
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
      // Marked as in flight machine-wide: the app runs one call at a time for every agent.
      const res = await inAppCall(appConfig.home, () => client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 }));
      if (!res.isError) return res;
      return { ...res, content: res.content.map((c) => (c.type === "text" ? { ...c, text: stripCode(c.text) } : c)) };
    } catch (err) {
      // The app reports tool failures (e.g. a snippet error with its editId) as JSON-RPC errors.
      // Hand those back as a normal error result; only a broken connection needs a new client.
      if (err instanceof McpError && err.code === ErrorCode.InternalError) {
        return { content: [{ type: "text", text: stripCode(err.message) }], isError: true };
      }
      this.invalidate();
      this.#reset();
      throw new Error(`pen.dev app call ${name} failed: ${err.message}`);
    }
  }

  /**
   * Resolved path of the document in the app's active window, or null. Cached for
   * stateTtlMs; pass { fresh: true } where a stale answer could misroute a write.
   * Concurrent callers share one request.
   */
  async activeFile({ fresh = false } = {}) {
    if (!(await this.available())) return null;
    const cached = this.activeCache;
    if (!fresh && cached && Date.now() - cached.at < appConfig.stateTtlMs) return cached.file;
    this.activeInFlight ??= (async () => {
      const res = await this.call("get_app_state");
      const match = ACTIVE.exec(textOf(res));
      const file = match ? this.resolvePath(match[1]) : null;
      this.activeCache = { file, at: Date.now() };
      return file;
    })().finally(() => (this.activeInFlight = null));
    return this.activeInFlight;
  }

  /** Forget the cached active document (after errors, or when pen-multi changed the app's windows). */
  invalidate() {
    this.activeCache = null;
  }

  /** Documents with their own app window. Read fresh every time; concurrent callers share one read. */
  async windowFiles() {
    if (!(await this.available())) return new Set();
    this.windowsInFlight ??= this.#readWindowFiles()
      .then((files) => new Set(files.map((f) => this.resolvePath(f))))
      .finally(() => (this.windowsInFlight = null));
    return this.windowsInFlight;
  }

  /**
   * Documents open in the app: every window's document plus the active one (documents opened
   * from the app's dashboard have no window entry). The official server routes a filePath
   * correctly to any open document; only unopened ones fall back to the active document.
   */
  async openFiles({ fresh = false } = {}) {
    const [windows, active] = await Promise.all([this.windowFiles(), this.activeFile({ fresh }).catch(() => null)]);
    return active ? new Set([...windows, active]) : windows;
  }

  async #readWindowFiles() {
    if (appConfig.docsFile) {
      try {
        const docs = JSON.parse(fs.readFileSync(appConfig.docsFile, "utf8"));
        return Array.isArray(docs) ? docs : (docs.open ?? []);
      } catch {
        return [];
      }
    }
    const ps = await new Promise((resolve) =>
      execFile("ps", ["-axww", "-o", "command="], { maxBuffer: 32 << 20 }, (err, out) => resolve(err ? "" : out)),
    );
    const files = [];
    for (const line of ps.split("\n")) {
      if (!line.includes("Pen Helper (Renderer)")) continue;
      for (const [, uri] of line.matchAll(/"fileURI":"(file:\/\/[^"]+)"/g)) {
        try {
          files.push(fileURLToPath(uri));
        } catch {}
      }
    }
    return files;
  }

  /**
   * Opens `file` in the app in the background: the app is never brought to the front, so it
   * does not take focus from whatever the user is working in. Resolves once the app has it open.
   */
  async openInBackground(file) {
    this.invalidate();
    if ((await this.openFiles({ fresh: true })).has(file)) return;
    const [cmd, ...args] = appConfig.openCommand;
    await new Promise((resolve, reject) =>
      execFile(cmd, [...args, file], (err) =>
        err ? reject(new Error(`could not open ${file} in the pen.dev app: ${err.message}`)) : resolve(),
      ),
    );
    const deadline = Date.now() + appConfig.openTimeoutMs;
    while (Date.now() < deadline) {
      if ((await this.openFiles({ fresh: true })).has(file)) return;
      await sleep(500);
    }
    throw new Error(`The pen.dev app did not open ${file} within ${appConfig.openTimeoutMs / 1000}s.`);
  }

  /** Whether Pen's windows are shown (not hidden with Cmd+H). */
  async penVisible() {
    if (!appConfig.ui) return true;
    return (await osa('tell application "System Events" to get visible of process "Pen"')) !== "false";
  }

  async setPenVisible(visible) {
    if (appConfig.ui) await osa(`tell application "System Events" to set visible of process "Pen" to ${visible}`);
  }

  /**
   * The app renders web pages and canvas imports only while its windows are shown; hidden, those
   * calls time out. If the user has hidden Pen, show it for the duration of fn and hide it again.
   * Showing never brings Pen to the front: its windows stay behind the app the user is in.
   */
  async withRendering(fn) {
    const wasVisible = await this.penVisible();
    if (!wasVisible) {
      await this.setPenVisible(true);
      await sleep(500);
    }
    try {
      return await fn();
    } finally {
      if (!wasVisible) await this.setPenVisible(false);
    }
  }

  /**
   * The workbench is one scratch document pen-multi keeps open in the app, with its window moved
   * off screen, for every browser action. The user's own windows are never opened or touched.
   * Opening it shows a window once (behind the user's app) until it is moved away.
   */
  async ensureWorkbench() {
    const file = this.resolvePath(appConfig.workbench);
    if (!(await this.openFiles()).has(file)) {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await runCli(["interactive", "-o", file], ["save()", "exit()"]);
      }
      const wasVisible = await this.penVisible();
      const previous = await this.activeFile().catch(() => null);
      // Opening makes the workbench the app's active window. Re-activating the user's window would
      // raise Pen above other apps, so remember which document was theirs instead.
      if (previous) this.#rememberUserActive(previous);
      await this.openInBackground(file);
      await this.#moveOffScreen(file);
      if (!wasVisible) await this.setPenVisible(false);
    } else {
      await this.#moveOffScreen(file); // in case the user brought it back
    }
    return file;
  }

  #rememberUserActive(file) {
    try {
      fs.writeFileSync(`${this.workbenchFile}.user-active`, file);
    } catch {}
  }

  /**
   * The user's document for calls without a filePath: the app's active one, or, while the
   * workbench holds that role, the one that was active before pen-multi opened the workbench.
   */
  async userActiveFile({ fresh = false } = {}) {
    const active = await this.activeFile({ fresh });
    if (active !== this.workbenchFile) return active;
    try {
      const remembered = fs.readFileSync(`${this.workbenchFile}.user-active`, "utf8").trim();
      return (await this.windowFiles()).has(remembered) ? remembered : null;
    } catch {
      return null;
    }
  }

  get workbenchFile() {
    return this.resolvePath(appConfig.workbench);
  }

  async #moveOffScreen(file) {
    if (!appConfig.ui) return;
    // macOS keeps a sliver of the window on screen, in the bottom-left corner.
    await osa(
      `tell application "System Events" to tell process "Pen" to set position of window "${path.basename(file)}" to {-20000, 20000}`,
    );
  }

  /**
   * Saves an open app document to disk through the CLI's app mode, which reaches the app's
   * save command. The CLI reports success even for a document that is not open, so success is
   * judged by the file's modification time, never by the CLI's output.
   */
  save(file) {
    const prev = this.saving.get(file) ?? Promise.resolve();
    const run = async () => {
      const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
      await runCli(["interactive", "-a", "desktop", "-i", file], ["save()", "exit()"]);
      const after = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
      if (after <= before) throw new Error(`the pen.dev app did not write ${file} to disk`);
    };
    const next = prev.then(run, run);
    this.saving.set(file, next.catch(() => {}));
    return next;
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  async #client() {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ name: "pen-multi", version: "1.6.1" });
      const transport = new StdioClientTransport({
        command: appConfig.server,
        args: ["--app", "desktop", "--agent", appConfig.agent, "--enable_spawn_agents"],
        env: process.env, // the SDK otherwise passes only a minimal default environment
        stderr: "ignore",
      });
      await client.connect(transport);
      client.onclose = () => this.#reset();
      await warmUp(client);
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

/**
 * The app's server answers the first call on a new connection with "failed to execute tool call.
 * you are probably referencing the wrong .pen file" and works from then on. A read-only call
 * absorbs that before the connection carries real work, where a failed write would be misleading.
 */
async function warmUp(client) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await client.callTool({ name: "get_app_state", arguments: {} }, undefined, { timeout: 60_000 }).catch(() => null);
    if (res && !res.isError) return;
    await sleep(200);
  }
}

/** Runs a short-lived CLI session with the given shell lines; resolves with its output. */
function runCli(args, lines, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [resolveCliEntry(), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`pen CLI ${args.join(" ")} timed out`));
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stripAnsi(out));
      else reject(new Error(`pen CLI exited with ${code}: ${stripAnsi(out).trim().slice(-500)}`));
    });
    proc.stdin.end(lines.join("\n") + "\n");
  });
}
