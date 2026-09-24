#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppBridge, AppUnavailableError, textOf } from "./app.js";
import { toContent } from "./format.js";
import { FileLock, SessionPool, config, normalize, withMachineLock } from "./pool.js";
import { cliVersion } from "./shell.js";

const pool = new SessionPool();
const app = new AppBridge(normalize);

const INSTRUCTIONS = `pen.dev editor for .pen design files (web/mobile apps and websites): read, generate, and validate designs. Covers every tool of the official pen.dev MCP server, and works with or without the pen.dev desktop app.

.pen files are encrypted: access them only via these tools, never Read or Grep them. Follow each tool's input schema exactly, and call read_skill to learn the .pen schema and the execute rules before designing.

Where a call runs:
- A file open in the running pen.dev desktop app (any window, active or not) is edited in the app, so the user sees it live.
- Any other file is edited in its own headless editor; no app needed.
- No filePath means the app's active document, like the official server.
- browser's canvas actions (import-to-canvas, screenshot-to-canvas) and spawn_agents need the file in the app: if it is not open there, it is opened in the background. The app is never brought to the front and never takes focus from what the user is doing.
- browser's read actions (load-page, return-element, return-screenshot) work with any file. Each app window has its own browser and agents take turns on them; pass url together with any other browser action to load the page and act on it in one step.
- ${config.autosave ? "Every successful change is saved to disk automatically, in the app too (this also saves the user's own unsaved edits in that document)." : "Changes are not saved automatically: call save for headless files; the user saves app documents."}
- Each response starts with "File: <path>" and says where it ran. A file is never silently routed to another document.

Many agents and projects:
- Relative filePaths resolve against this agent's working directory (${process.cwd()}).
- A file can be edited headlessly by only one agent at a time; the error names the agent's project holding it. fork_version copies a file so you can work on a separate version in parallel.
- Global variables set in execute live only while a headless file stays open. Idle files close after ${config.idleMs / 60_000} minutes or when editor slots run out; re-read ids with Get instead of relying on old globals. Call close_file when done to free the slot for other agents.`;

const server = new McpServer({ name: "pen-multi", version: "0.3.0" }, { instructions: INSTRUCTIONS });

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

const APP_ONLY_HELP = {
  spawn_agents:
    "Without the app, split the work with your own subagents instead: give each one a container node and the same filePath. " +
    "Their execute calls on that file are queued one at a time, so they cannot overwrite each other.",
};

const fromApp = (res, target, note) => ({
  ...res,
  content: [
    { type: "text", text: `File: ${target.file} (in the pen.dev desktop app${target.opened ? ", opened in the background" : ""})` },
    ...(res.content ?? []),
    ...(note && !res.isError ? [{ type: "text", text: note }] : []),
  ],
});

/** Runs a document-changing app call, then saves the document to disk when autosave is on. */
async function appWrite(target, name, args, send = (t, a) => app.call(name, { filePath: t.file, ...a })) {
  const res = await send(target, args);
  if (res.isError) return fromApp(res, target);
  if (!config.autosave) return fromApp(res, target, "Not saved to disk (autosave is off): save it in the pen.dev app.");
  try {
    await app.save(target.file);
    return fromApp(res, target, "Saved to disk.");
  } catch (err) {
    return fromApp(res, target, `WARNING: the change is in the app but not on disk (${err.message}). Save it in the pen.dev app (Cmd+S).`);
  }
}

const heldByOtherAgent = (file) => {
  try {
    new FileLock(file).assertNotHeldElsewhere();
    return null;
  } catch (err) {
    return err.message;
  }
};

/**
 * Decides where a file-scoped call runs. A file goes to the app only when the app verifiably has
 * it open (or has just opened it in the background): the official server silently falls back to
 * the active document for files it does not have open.
 */
async function route(f, { needsApp = false, tool: toolName } = {}) {
  const appUp = await app.available();
  const unavailable = (msg) => new AppUnavailableError([msg, APP_ONLY_HELP[toolName]].filter(Boolean).join(" "));
  if (!f) {
    const active = appUp ? await app.activeFile() : null;
    if (active) return { mode: "app", file: active };
    if (!appUp) {
      throw unavailable(
        needsApp
          ? "This needs the pen.dev desktop app, which is not running."
          : "No filePath given and the pen.dev desktop app is not running. Pass filePath to work on a file without the app.",
      );
    }
    throw new Error("The pen.dev app has no document open. Open one, or pass filePath.");
  }

  const file = normalize(f);
  if (!appUp) {
    if (needsApp) throw unavailable("This needs the pen.dev desktop app, which is not running.");
    return { mode: "headless", file };
  }
  const openInApp = (await app.openFiles()).has(file);
  if (!openInApp && !needsApp) return { mode: "headless", file };

  const other = heldByOtherAgent(file);
  if (other) throw new Error(`Cannot use ${file} in the pen.dev app: ${other}`);
  if (pool.sessions.has(file)) {
    if (openInApp) {
      throw new Error(
        `${file} is open both headlessly here and in the pen.dev app, and the two would overwrite each other. ` +
          `close_file it here (this saves it), then reload it in the app so the app has the saved version.`,
      );
    }
    await pool.close(file); // hand the headless editor over: saved to disk, then opened by the app
  }
  if (!openInApp) {
    if (!fs.existsSync(file)) {
      await pool.use(file, (s) => pool.save(s)); // the app can only open a file that exists
      await pool.close(file);
    }
    await app.openInBackground(file);
  }
  return { mode: "app", file, opened: !openInApp };
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
  "Get the state of a .pen document: top-level nodes, reusable components, and the user's selection. Omit filePath for the pen.dev app's active document and its integrated browser state.",
  { filePath: optionalFilePath },
  async ({ filePath: f }) => {
    const target = await route(f);
    if (target.mode === "app") return fromApp(await app.call("get_app_state"), target);
    return pool.use(target.file, async (session, warnings) => {
      const res = await session.shell.call("get_app_state");
      return res.error ? fail(res.error, target.file) : ok(res.text, warnings, target.file);
    });
  },
);

tool(
  "execute",
  "Run a JavaScript snippet against one .pen file (Insert/Update/Get/Print/TakeScreenshot/Export/Generate/...; see read_skill execute.md). Runs in the pen.dev app when the file is open there (or filePath is omitted), otherwise in a headless editor. On failure, retry with editId + edits instead of resending the snippet.",
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
    if (target.mode === "app") return appWrite(target, "execute", payload);
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

const BROWSER_READS = new Set(["load-page", "return-element", "return-screenshot"]);

tool(
  "browser",
  `Interact with a real website loaded in the pen.dev app's integrated browser: open a URL, reproduce a page (or one element) as editable canvas layers, screenshot it, or pull its DOM/screenshot back into the conversation. Needs the pen.dev desktop app running (it is never brought to the front).

- "load-page": load "url" in the browser.
- "return-element": return the target element's DOM and computed styles as text.
- "return-screenshot": return a screenshot of the target as an image for you to inspect.
- "import-to-canvas": reproduce the target as editable layers in filePath's document; reports the imported frame's id for execute.
- "screenshot-to-canvas": place a screenshot of the target in filePath's document as an image.

The read actions work with any file, headless or not. The canvas actions open filePath in the app in the background if needed. Each app window has its own browser, shared by all agents: pass url with any other action to load the page in the right window and act on it in one step, so no other agent can change the page in between.

target: "full-page" (default), "selection" (element picked with the browser's element picker), or "query" (with querySelector). Prefer "query" or "selection"; "return-element" on broad selectors can be huge. nodeId drives a browser node on filePath's canvas instead of the sidebar. Imported pages are normal canvas nodes: edit them with execute.`,
  {
    action: z
      .enum(["load-page", "import-to-canvas", "screenshot-to-canvas", "return-element", "return-screenshot"])
      .describe("What to do: load-page, import-to-canvas, screenshot-to-canvas, return-element, or return-screenshot."),
    filePath: optionalFilePath,
    nodeId: z.string().optional().describe("Id of a browser node in the document to drive. Omit to drive the browser sidebar's own page."),
    target: z.enum(["full-page", "selection", "query"]).optional().describe("What to act on (default full-page)."),
    querySelector: z.string().optional().describe('A CSS selector executed in the page. Required when target is "query".'),
    url: z
      .string()
      .optional()
      .describe('An http(s) or file URL. Required for "load-page"; with any other action, the page is loaded first in the same step.'),
  },
  async ({ filePath: f, url, ...rest }) => {
    const reading = BROWSER_READS.has(rest.action) && !rest.nodeId;
    const target = reading ? await browserTarget(f) : await route(f, { needsApp: true, tool: "browser" });
    return withMachineLock("pen.dev app browser", async () => {
      if (url && rest.action !== "load-page") {
        const loaded = await browserCall(target, { action: "load-page", url, ...pick(rest, "nodeId") });
        if (loaded.isError) return fromApp(withHint(loaded, url), target);
      }
      const args = { ...rest, ...(rest.action === "load-page" ? { url } : {}) };
      if (reading) return fromApp(withHint(await browserCall(target, args), url), target);
      const res = await appWrite(target, "browser", args, browserCall);
      return withHint(res, url);
    });
  },
);

// A window the app has just opened answers "No handler found for method 'browser'" until its
// browser is ready; give it a few seconds before reporting a failure.
async function browserCall(target, args) {
  for (let attempt = 0; ; attempt++) {
    const res = await app.call("browser", { filePath: target.file, ...args });
    if (!res.isError || attempt >= 5 || !/No handler found/.test(textOf(res))) return res;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const withHint = (res, url) =>
  res.isError && !url
    ? {
        ...res,
        content: [
          ...res.content,
          { type: "text", text: "Each pen.dev app window has its own browser. Pass url so the page is loaded in this document's window first." },
        ],
      }
    : res;

const pick = (obj, ...keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * Read actions do not touch the document, so any file will do: the file itself when the app has
 * it open, otherwise the app's active document, which owns the browser sidebar in use.
 */
async function browserTarget(f) {
  if (!(await app.available())) throw new AppUnavailableError("browser needs the pen.dev desktop app, which is not running.");
  if (f) {
    const file = normalize(f);
    if ((await app.openFiles()).has(file)) return { mode: "app", file };
  }
  const active = await app.activeFile();
  if (!active) throw new Error("The pen.dev app has no document open, so its browser is not available. Open any document in the app.");
  return { mode: "app", file: active };
}

tool(
  "spawn_agents",
  `Split a design task across several designer agents that work in parallel inside the pen.dev app. filePath is opened in the app in the background if needed (the app is never brought to the front). Always create one agent fewer than needed: this session does the last part.

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
    const target = await route(f, { needsApp: true, tool: "spawn_agents" });
    return appWrite(target, "spawn_agents", { config: agents });
  },
);

tool(
  "save",
  "Write a .pen document to disk, whether it is open headlessly or in the pen.dev app. Only needed when autosave is off.",
  { filePath },
  async ({ filePath: f }) => {
    const file = normalize(f);
    if (pool.sessions.has(file)) return pool.use(file, async (session) => ok(await pool.save(session), [], file));
    if ((await app.openFiles()).has(file)) {
      await app.save(file);
      return ok(`Saved ${file} from the pen.dev app.`, [], file);
    }
    throw new Error(`${file} is not open here or in the pen.dev app.`);
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
    if (closed) return ok(`Closed ${file}`);
    const inApp = (await app.openFiles().catch(() => new Set())).has(file);
    return ok(inApp ? `${file} is open in the pen.dev app, not here; close its window in the app if needed.` : `${file} was not open.`);
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
      ? { running: true, activeDocument: await app.activeFile().catch(() => null), openDocuments: [...(await app.openFiles())] }
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
