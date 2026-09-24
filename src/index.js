#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppBridge, AppUnavailableError } from "./app.js";
import { toContent } from "./format.js";
import { FileLock, SessionPool, config, normalize } from "./pool.js";
import { cliVersion } from "./shell.js";

const pool = new SessionPool();
const app = new AppBridge(normalize);

const INSTRUCTIONS = `pen.dev editor for .pen design files (web/mobile apps and websites): read, generate, and validate designs. Covers every tool of the official pen.dev MCP server, and works with or without the pen.dev desktop app.

.pen files are encrypted: access them only via these tools, never Read or Grep them. Follow each tool's input schema exactly, and call read_skill to learn the .pen schema and the execute rules before designing.

Where a call runs:
- A filePath that is the ACTIVE tab of the running pen.dev desktop app is edited live in the app (the user sees it; the app saves it to disk when the user saves).
- Any other filePath is edited in its own headless editor, no app needed, and ${config.autosave ? "saved to disk after every successful execute" : "kept in memory until save"}.
- No filePath means the app's active document, like the official server. browser and spawn_agents always need the app, on its active document.
- Each response starts with "File: <path>" and says which of the two it used. A file is never silently routed to another document.

Many agents and projects:
- Relative filePaths resolve against this agent's working directory (${process.cwd()}).
- A file can be edited headlessly by only one agent at a time; the error names the agent's project holding it. fork_version copies a file so you can work on a separate version in parallel.
- Global variables set in execute live only while a headless file stays open. Idle files close after ${config.idleMs / 60_000} minutes or when editor slots run out; re-read ids with Get instead of relying on old globals. Call close_file when done to free the slot for other agents.`;

const server = new McpServer({ name: "pen-multi", version: "0.2.0" }, { instructions: INSTRUCTIONS });

const filePath = z
  .string()
  .describe("Path to the .pen file: absolute, or relative to this agent's working directory. Identifies the editor session.");
const optionalFilePath = z
  .string()
  .optional()
  .describe("Path to the .pen file (absolute, or relative to this agent's working directory). Omit to use the pen.dev app's active document.");

const ok = (text, warnings = [], file) => ({
  content: toContent(
    [file && `File: ${file}`, ...warnings.map((w) => `WARNING: ${w}`), text].filter(Boolean).join("\n\n"),
  ),
});
const fail = (text, file) => ({ content: [{ type: "text", text: file ? `File: ${file}\n\n${text}` : text }], isError: true });

const LIVE_NOTE = "Edited live in the pen.dev desktop app; the change reaches disk when the document is saved in the app (Cmd+S).";
const fromApp = (res, file, note) => ({
  ...res,
  content: [
    { type: "text", text: `File: ${file} (live in the pen.dev desktop app)` },
    ...(res.content ?? []),
    ...(note && !res.isError ? [{ type: "text", text: note }] : []),
  ],
});

/**
 * Decides where a file-scoped call runs. The app is used only for its verified active document,
 * which is what makes routing safe: the official server silently falls back to the active
 * document for files it does not have open.
 */
async function route(f, { appOnly = false } = {}) {
  const active = await app.activeFile().catch(() => null);
  if (!f) {
    if (active) return { mode: "app", file: active };
    if (!(await app.available())) {
      throw new AppUnavailableError(
        appOnly
          ? "This needs the pen.dev desktop app, which is not running. Open the app with the document as its active tab."
          : "No filePath given and the pen.dev desktop app is not running. Pass filePath to work on a file without the app.",
      );
    }
    throw new Error("The pen.dev app has no document open. Open one, or pass filePath.");
  }
  const file = normalize(f);
  if (active === file) {
    if (pool.sessions.has(file)) {
      throw new Error(
        `${file} is open both headlessly here and as the active tab of the pen.dev app, and the two would overwrite each other. ` +
          `Either close_file it here (this saves it) and reopen it in the app so the app loads the saved version, or switch the app to another tab to keep editing headlessly.`,
      );
    }
    return { mode: "app", file };
  }
  if (appOnly) {
    throw new Error(
      `This needs the pen.dev desktop app with ${file} as its active tab` +
        (active ? ` (the active tab is ${active}).` : (await app.available()) ? " (no document is active)." : ", but the app is not running."),
    );
  }
  return { mode: "headless", file };
}

const tool = (name, description, schema, handler) =>
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return fail(err.message);
    }
  });

// read_skill / get_style return static content for a given CLI version. Every agent reads them
// first, so answers are cached on disk and shared by all pen-multi processes on this machine.
const staticDir = path.join(config.cacheDir, cliVersion());
const utilityFile = path.join(os.tmpdir(), `pen-multi-utility-${process.pid}.pen`);
async function staticCall(name, args) {
  const cached = path.join(staticDir, createHash("sha1").update(name + JSON.stringify(args ?? {})).digest("hex") + ".txt");
  if (fs.existsSync(cached)) return ok(fs.readFileSync(cached, "utf8"));

  // Any open editor can answer; otherwise start a throwaway one and close it straight away.
  const [open] = pool.sessions.keys();
  const res = await pool.use(open ?? utilityFile, (s) => s.shell.call(name, args));
  if (!open && !pool.busy(utilityFile)) {
    await pool.close(utilityFile, { save: false }).finally(() => fs.rmSync(utilityFile, { force: true }));
  }
  if (res.error) return fail(res.error);

  fs.mkdirSync(staticDir, { recursive: true });
  const tmp = `${cached}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, res.text);
  fs.renameSync(tmp, cached); // atomic, so concurrent agents never read a partial file
  return ok(res.text);
}

tool(
  "read_skill",
  "Read the pen-dev skill that teaches how to design on the pen.dev canvas. read_skill() returns SKILL.md; read_skill({ path }) reads a file referenced from it (e.g. \"execute.md\", \"pen-schema.md\").",
  { path: z.string().optional().describe("Relative path of a file referenced from SKILL.md. Omit for SKILL.md.") },
  ({ path: p }) => staticCall("read_skill", p ? { path: p } : undefined),
);

tool(
  "get_style",
  "Load visual style archetypes for working with .pen files. Styles provide configurable fonts, colors, and imagery; they do not save variables, only provide reference values.\n\nUsage:\n1. get_style(): list available styles\n2. get_style({ name }): load a style, or get its required params\n3. get_style({ name, params }): load a style with params",
  {
    name: z.string().optional().describe("Style name from the listing"),
    params: z.record(z.string(), z.any()).optional().describe("Key-value pairs for required params returned in step 2"),
  },
  ({ name, params }) => staticCall("get_style", name ? { name, ...(params ? { params } : {}) } : undefined),
);

tool(
  "open_file",
  "Open a .pen file in its own headless editor (optional: execute/get_app_state open it on demand). A missing file starts as an empty document. Pass sourcePath to create filePath as a new version seeded from another .pen file.",
  {
    filePath,
    sourcePath: z.string().optional().describe("Path of an existing .pen file to seed a new filePath from."),
  },
  async ({ filePath: f, sourcePath }) => {
    const file = normalize(f);
    const inPath = sourcePath ? normalize(sourcePath) : undefined;
    if (inPath && fs.existsSync(file)) throw new Error(`${file} already exists; use fork_version or pick a new path.`);
    return pool.use(
      file,
      async (session, warnings) => {
        if (inPath) await pool.save(session);
        const res = await session.shell.call("get_app_state");
        return res.error ? fail(res.error, file) : ok(res.text, warnings, file);
      },
      { inPath },
    );
  },
);

tool(
  "get_app_state",
  "Get the state of a .pen document: top-level nodes, reusable components, and the user's selection when it is open in the pen.dev app. Omit filePath for the app's active document and the app's integrated browser state. Opens a headless editor if needed.",
  { filePath: optionalFilePath },
  async ({ filePath: f }) => {
    const target = await route(f);
    if (target.mode === "app") return fromApp(await app.call("get_app_state"), target.file);
    return pool.use(target.file, async (session, warnings) => {
      const res = await session.shell.call("get_app_state");
      return res.error ? fail(res.error, target.file) : ok(res.text, warnings, target.file);
    });
  },
);

tool(
  "execute",
  "Run a JavaScript snippet against one .pen file (Insert/Update/Get/Print/TakeScreenshot/Export/Generate/...; see read_skill execute.md). Runs live in the pen.dev app when the file is its active tab (or filePath is omitted), otherwise in a headless editor. On failure, retry with editId + edits instead of resending the snippet.",
  {
    filePath: optionalFilePath,
    input: z.string().optional().describe("The JavaScript snippet to execute. Required unless `edits` is provided."),
    editId: z.string().optional().describe("Id of the failed snippet to patch, from that call's failure message. Only with `edits`."),
    edits: z
      .array(
        z.object({
          find: z.string().describe("Exact text in the failed snippet to replace."),
          replace: z.string(),
          all: z.boolean().optional().describe("Replace every occurrence."),
        }),
      )
      .optional()
      .describe("Patches for the failed snippet identified by editId; applied in order, then the snippet re-runs."),
  },
  async ({ filePath: f, input, editId, edits }) => {
    if (!input && !(editId && edits)) throw new Error("Provide `input`, or `editId` together with `edits`.");
    const payload = input ? { input } : { editId, edits };
    const target = await route(f);
    if (target.mode === "app") {
      return fromApp(await app.call("execute", { filePath: target.file, ...payload }), target.file, LIVE_NOTE);
    }
    const file = target.file;
    return pool.use(file, async (session, warnings) => {
      const res = await session.shell.call("execute", payload);
      if (res.error) return fail(res.error, file);
      session.dirty = true;
      if (config.autosave) await pool.save(session);
      return ok(res.text, warnings, file);
    });
  },
);

tool(
  "browser",
  `Interact with a real website loaded in the pen.dev app's integrated browser: open a URL, reproduce a page (or one element) as editable canvas layers, screenshot it, or pull its DOM/screenshot back into the conversation. Needs the pen.dev desktop app, and acts on its active document.

- "load-page": load "url" in the target browser. Call it before the other actions.
- "import-to-canvas": reproduce the target as editable layers; reports the imported frame's id for execute.
- "screenshot-to-canvas": place a screenshot of the target on the canvas as an image.
- "return-element": return the target element's DOM and computed styles as text.
- "return-screenshot": return a screenshot of the target as an image for you to inspect.

target: "full-page" (default), "selection" (element picked with the browser's element picker), or "query" (with querySelector). Prefer "query" or "selection"; "return-element" on broad selectors can be huge. nodeId drives a browser node on the canvas instead of the sidebar. localhost dev servers live-reload: skip "load-page" when the page is already loaded. Imported pages are normal canvas nodes: edit them with execute.`,
  {
    action: z
      .enum(["load-page", "import-to-canvas", "screenshot-to-canvas", "return-element", "return-screenshot"])
      .describe("What to do: load-page, import-to-canvas, screenshot-to-canvas, return-element, or return-screenshot."),
    filePath: optionalFilePath,
    nodeId: z.string().optional().describe("Id of a browser node in the document to drive. Omit to drive the browser sidebar's own page."),
    target: z.enum(["full-page", "selection", "query"]).optional().describe("What to act on (default full-page)."),
    querySelector: z.string().optional().describe('A CSS selector executed in the page. Required when target is "query".'),
    url: z.string().optional().describe('An http(s) or file URL to load. Used when action is "load-page".'),
  },
  async ({ filePath: f, ...rest }) => {
    const { file } = await route(f, { appOnly: true });
    const note = ["import-to-canvas", "screenshot-to-canvas"].includes(rest.action) ? LIVE_NOTE : undefined;
    return fromApp(await app.call("browser", { filePath: file, ...rest }), file, note);
  },
);

tool(
  "spawn_agents",
  `Split a design task across several designer agents that work in parallel inside the pen.dev app, on its active document. Always create one agent fewer than needed: this session does the last part.

- Use it for multiple sections, screens, websites, or variations of a design.
- Create placeholder container nodes first and pass their ids in containerNodes; put related sections under one parent node. Do not set placeholder on those nodes or their parent.
- Designer agents do not inherit your guidelines: include guide/style names and params in each prompt. They can read the document's variables, so do not include them.
- Keep prompts brief and consistent across agents, and leave layout, sizes, colors and variable names to them.
- At most 8-10 agents at once.`,
  {
    filePath: optionalFilePath,
    config: z
      .array(
        z.object({
          prompt: z.string().describe("The prompt for the designer agent to run."),
          containerNodes: z
            .array(z.string())
            .describe("The valid node IDs in the document in which the designer agent should work. Always at least one."),
        }),
      )
      .describe("The config for the extra agents that will be spawned and run in parallel alongside the current agent."),
  },
  async ({ filePath: f, config: agents }) => {
    const { file } = await route(f, { appOnly: true });
    return fromApp(await app.call("spawn_agents", { filePath: file, config: agents }), file, LIVE_NOTE);
  },
);

tool(
  "save",
  "Write the in-memory document of a .pen file to disk. Only needed when autosave is off.",
  { filePath },
  async ({ filePath: f }) => {
    const file = normalize(f);
    if (!pool.sessions.has(file)) throw new Error(`${file} is not open.`);
    return pool.use(file, async (session) => ok(await pool.save(session), [], file));
  },
);

tool(
  "fork_version",
  "Copy a .pen file to a new path to work on a separate version (the original stays untouched). Saves the source first if it is open with unsaved changes. Returns the new path; pass it as filePath afterwards.",
  {
    filePath: filePath.describe("Path of the .pen file to copy."),
    newPath: z.string().describe("Path for the new version, e.g. design-v2.pen next to the original."),
    overwrite: z.boolean().optional().describe("Replace newPath if it exists and is not open. Default false."),
  },
  async ({ filePath: f, newPath, overwrite }) => {
    const src = normalize(f);
    const dst = normalize(newPath);
    if (src === dst) throw new Error("newPath must differ from filePath.");
    if (pool.sessions.get(src)?.dirty) await pool.use(src, (s) => pool.save(s));
    if (!fs.existsSync(src)) throw new Error(`Source file not found: ${src}`);
    if (pool.sessions.has(dst)) throw new Error(`${dst} is open; close it first.`);
    if (fs.existsSync(dst) && !overwrite) throw new Error(`${dst} already exists; pass overwrite: true to replace it.`);
    new FileLock(dst).assertNotHeldElsewhere();
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const warnings = [];
    if (path.dirname(src) !== path.dirname(dst) && fs.existsSync(path.join(path.dirname(src), "images"))) {
      warnings.push(
        `The source folder has an images/ directory. Generated images are referenced relative to the .pen file, so copy that folder next to ${dst} if the new version uses them.`,
      );
    }
    return ok(`Forked ${src}\n     -> ${dst}`, warnings);
  },
);

tool(
  "close_file",
  "Close the headless editor of a .pen file and free its memory. Saves unsaved changes unless save is false.",
  { filePath, save: z.boolean().optional().describe("Save unsaved changes before closing. Default true.") },
  async ({ filePath: f, save }) => {
    const file = normalize(f);
    const closed = await pool.close(file, { save: save !== false });
    return ok(closed ? `Closed ${file}` : `${file} was not open.`);
  },
);

tool(
  "list_sessions",
  "List the .pen files this agent has open headlessly, every file open by any agent on this machine, and the pen.dev app's active document.",
  {},
  async () => {
    const sessions = pool.list().filter((s) => s.filePath !== utilityFile);
    const machineWide = FileLock.live()
      .filter((h) => h.file !== utilityFile)
      .map((h) => ({ filePath: h.file, agentProject: h.cwd, pid: h.pid, since: h.since, thisAgent: h.pid === process.pid }));
    const limits = {
      perAgent: config.maxSessions,
      machineWide: config.globalMaxSessions,
      idleCloseMinutes: config.idleMs / 60_000,
      autosave: config.autosave,
    };
    const desktopApp = (await app.available())
      ? { running: true, activeDocument: await app.activeFile().catch(() => null) }
      : { running: false };
    return ok(JSON.stringify({ sessions, machineWide, desktopApp, limits }, null, 2));
  },
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([pool.closeAll(), app.close()]);
  fs.rmSync(utilityFile, { force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
