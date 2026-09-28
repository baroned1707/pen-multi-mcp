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
import { executeHints, mayWrite } from "./hints.js";
import { SaveScheduler } from "./saver.js";
import { Timings } from "./timing.js";
import { carryImages, readPrinted, snippets } from "./transfer.js";
import { FileLock, SessionPool, config, normalize, withMachineLock } from "./pool.js";
import { prewarm } from "./prewarm.js";
import { registerVerifyTools } from "./verify/tools.js";
import { registerLintTools } from "./lint/tools.js";
import { registerImportTools } from "./import/tools.js";
import { conventions } from "./design/tools.js";
import { cliVersion } from "./shell.js";
import { registerDesignTools } from "./design/tools.js";

const timings = new Timings();
const saver = new SaveScheduler({
  delayMs: Number(process.env.PEN_MULTI_SAVE_DELAY_MS ?? 1500),
  onError: (file, err) => process.stderr.write(`pen-multi: background save of ${file} failed: ${err.message}\n`),
});
const pool = new SessionPool({ saver });
let designTools = null; // overview/inspect; their cached analysis is dropped whenever a file is written
const designChanged = (file) => designTools?.invalidate(file);
const app = new AppBridge(normalize);

const INSTRUCTIONS = `pen.dev editor for .pen design files (web/mobile apps and websites): read, generate, and validate designs. Covers every tool of the official pen.dev MCP server, and works with or without the pen.dev desktop app.

Use this server for all pen.dev and .pen work. If the official "pencil" server is also connected, use these tools instead of it: pencil can only edit the app's active document and brings the Pen window to the front.

.pen files are encrypted: access them only via these tools, never Read or Grep them. Follow each tool's input schema exactly, and call read_skill to learn the .pen schema and the execute rules before designing.

Where a call runs:
- A file open in the running pen.dev desktop app (any window, active or not) is edited in the app, so the user sees it live.
- Any other file is edited in its own headless editor; no app needed.
- No filePath means the app's active document, like the official server.
- pen-multi never opens, focuses or raises the user's windows. browser runs in its own workbench window kept off screen; import-to-canvas and screenshot-to-canvas then move the result into filePath, headless or in the app. Agents take turns on the browser; pass url with any browser action to load the page and act on it in one step.
- spawn_agents runs in the app, so it needs filePath open there; otherwise use your own subagents on the same filePath.
- ${config.autosave ? "Every successful change is saved to disk automatically, in the background right after the call returns (in the app too, which also saves the user's own unsaved edits in that document). Call save before reading a .pen file from disk or committing it: it waits for the background save." : "Changes are not saved automatically: call save."}
- Each response starts with "File: <path>" and says where it ran. A file is never silently routed to another document.

Implementing or refactoring UI from a design (port mode):
- The design is the source of truth for structure, order, content and styling. "Update the existing component" means change it until it matches the design, never keep what is there; rebuild the app shell, navigation or a component when its structure differs.
- Before editing code: call overview, then inspect the target screen (save it with savePath and re-read that file after context compaction). List the structural differences between the design and the current UI (shell, navigation, section order, missing or extra elements) and work through that list.
- If project rules conflict with matching the design (e.g. "preserve the theme"), ask the user once which wins and follow the answer.
- Before porting a screen, run lint on it: a raw color, a default-named layer or a clipped text in the design becomes a bug in code. Fix what lint can fix (fix: ["names", "tokens"]) and ask the user about the rest. Keep code tokens in sync with tokens (compare the project's token file).
- Never port from screenshots or from memory: read the design as data with inspect. Screenshots are for a human sanity check, not for measurements.
- While implementing, mark elements with the layer address inspect prints: data-pen="Header/Title" on web, testID="pen:Header/Title" in React Native (add probe/react-native/PenProbe.js to the app root once).
- Screens built in code first: import_ui brings them into the design as a frame to refine. sync_status shows which screens were verified against the code, which are stale, and which never were; routes in .pen-multi.json let verify find each screen's page.
- A port is done only when verify reports MATCH for every implemented screen × width × theme: run it against the running app (web URL, pen-probe, native device, or a screenshot), fix the high findings first (missing, extra, order), then the rest, and re-run. Do not report a screen as done from a screenshot.

Many agents and projects:
- Relative filePaths resolve against this agent's working directory (${process.cwd()}).
- A file can be edited headlessly by only one agent at a time; the error names the agent's project holding it. fork_version copies a file so you can work on a separate version in parallel.
- Global variables set in execute live only while a headless file stays open. Idle files close after ${config.idleMs / 60_000} minutes or when editor slots run out; re-read ids with Get instead of relying on old globals. Call close_file when done to free the slot for other agents.
- Every execute call costs ~0.4 s however small, so put related reads and writes in one snippet instead of many small calls.`;

const server = new McpServer({ name: "pen-multi", version: "0.9.0" }, { instructions: INSTRUCTIONS });

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
const SAVING_NOTE = "Saving to disk in the background; call save before reading or committing this file.";
const NOT_SAVING_NOTE = "Not saved to disk (autosave is off): call save.";
const saveWarning = (file) => (saver.error(file) ? [`the last background save of this file failed: ${saver.error(file)}`] : []);

/** Schedules a background save of a headless session. */
const scheduleHeadlessSave = (session) =>
  saver.markDirty(session.file, () => timings.time("save", () => (session.dirty ? pool.save(session) : undefined)));

/** Schedules a background save of an app document. */
const scheduleAppSave = (file) => saver.markDirty(file, () => timings.time("save", () => app.save(file)));

const withHints = (res, hints) =>
  hints.length ? { ...res, content: [...res.content, { type: "text", text: hints.map((h) => `HINT: ${h}`).join("\n") }] } : res;

const fail = (text, file) => ({ content: [{ type: "text", text: file ? `File: ${file}\n\n${text}` : text }], isError: true });

const APP_ONLY_HELP = {
  spawn_agents:
    "Split the work with your own subagents instead: give each one a container node and the same filePath. " +
    "Their execute calls on that file are queued one at a time, so they cannot overwrite each other.",
};

const fromApp = (res, target, note) => ({
  ...res,
  content: [
    { type: "text", text: target.workbench ? "(pen-multi workbench in the pen.dev desktop app)" : `File: ${target.file} (in the pen.dev desktop app)` },
    ...(res.content ?? []),
    ...(note && !res.isError ? [{ type: "text", text: note }] : []),
  ],
});

/** Runs a document-changing app call, then schedules a background save when autosave is on. */
async function appWrite(target, name, args, send = (t, a) => app.call(name, { filePath: t.file, ...a })) {
  const warnings = saveWarning(target.file);
  const res = await timings.time("call", () => send(target, args));
  if (res.isError) return fromApp(res, target);
  designChanged(target.file);
  if (!config.autosave) return fromApp(res, target, NOT_SAVING_NOTE);
  scheduleAppSave(target.file);
  return fromApp(res, target, [...warnings.map((w) => `WARNING: ${w}`), SAVING_NOTE].join("\n"));
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
const route = (f, opts) => timings.time("route", () => routeUntimed(f, opts));

async function routeUntimed(f, { needsApp = false, tool: toolName, write = false } = {}) {
  const appUp = await app.available();
  const unavailable = (msg) => new AppUnavailableError([msg, APP_ONLY_HELP[toolName]].filter(Boolean).join(" "));
  if (!f) {
    // A write without filePath targets whatever is active now, so never trust the cache for it.
    const active = appUp ? await app.userActiveFile({ fresh: write }) : null;
    if (active) return { mode: "app", file: active };
    if (appUp && (await app.activeFile()) === app.workbenchFile) {
      throw new Error("The pen.dev app's active window is pen-multi's workbench, not a design. Pass filePath.");
    }
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
  let openInApp = (await app.windowFiles()).has(file);
  if (!openInApp && (await app.activeFile().catch(() => null)) === file) {
    // Dashboard-opened documents have no window entry and are only known as the active one.
    // For a write, confirm that with a fresh read rather than a cached one that may be stale.
    openInApp = !write || (await app.activeFile({ fresh: true }).catch(() => null)) === file;
  }
  if (!openInApp) {
    // Opening the user's file in the app would put a window in front of whatever they are doing.
    if (needsApp) {
      throw new Error(
        [`This needs ${file} open in the pen.dev app, and pen-multi never opens windows for you.`, APP_ONLY_HELP[toolName]]
          .filter(Boolean)
          .join(" "),
      );
    }
    return { mode: "headless", file };
  }
  const other = heldByOtherAgent(file);
  if (other) throw new Error(`Cannot use ${file} in the pen.dev app: ${other}`);
  if (pool.sessions.has(file)) {
    app.invalidate();
    throw new Error(
      `${file} is open both headlessly here and in the pen.dev app, and the two would overwrite each other. ` +
        `close_file it here (this saves it), then reload it in the app so the app has the saved version.`,
    );
  }
  return { mode: "app", file };
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
    if (target.mode === "app") {
      // The app's get_app_state has no filePath: it always describes the active document.
      if ((await app.activeFile().catch(() => null)) === target.file) return fromApp(await app.call("get_app_state"), target);
      const res = await app.call("execute", { filePath: target.file, input: snippets.documentState() });
      return fromApp(res, target, "Selection and browser state are only reported for the app's active document; this one is open in a background window.");
    }
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
  (args) => executeSnippet(args),
);

/** The execute tool's work: routes the file, runs the snippet, marks writes dirty and saves them. */
async function executeSnippet({ filePath: f, input, editId, edits }) {
    if (!input && !(editId && edits)) throw new Error("Provide `input`, or `editId` together with `edits`.");
    const payload = input ? { input } : { editId, edits };
    const writes = mayWrite(input);
    const target = await route(f, { write: writes });
    if (target.mode === "app") {
      const res = writes
        ? await appWrite(target, "execute", payload)
        : fromApp(await timings.time("call", () => app.call("execute", { filePath: target.file, ...payload })), target);
      return withHints(res, executeHints({ input, text: textOf(res), error: res.isError ? textOf(res) : null }));
    }
    const file = target.file;
    return pool.use(file, async (session, warnings) => {
      const res = await timings.time("call", () => session.shell.call("execute", payload));
      const hints = executeHints({ input, text: res.text, error: res.error });
      if (res.error) return withHints(fail(res.error, file), hints);
      const notes = [...warnings, ...saveWarning(file)];
      if (!writes) return withHints(ok(res.text, notes, file), hints);
      session.dirty = true;
      designChanged(file);
      if (config.autosave) scheduleHeadlessSave(session);
      return withHints(ok(`${res.text}\n\n${config.autosave ? SAVING_NOTE : NOT_SAVING_NOTE}`, notes, file), hints);
    });
}

const BROWSER_READS = new Set(["load-page", "return-element", "return-screenshot"]);
const BROWSER_LOCK = "pen.dev app browser";

tool(
  "browser",
  `Interact with a real website in the pen.dev app's integrated browser: open a URL, reproduce a page (or one element) as editable canvas layers, screenshot it, or pull its DOM/screenshot back into the conversation. Needs the pen.dev desktop app running. It runs in a pen-multi workbench window kept off screen, so the user's windows are never opened, focused or brought to the front.

- "load-page": load "url" in the browser.
- "return-element": return the target element's DOM and computed styles as text.
- "return-screenshot": return a screenshot of the target as an image for you to inspect.
- "import-to-canvas": reproduce the target as editable layers in filePath's document (headless or open in the app); reports the new frame's id for execute.
- "screenshot-to-canvas": place a screenshot of the target in filePath's document as an image.

The browser is shared by all agents: pass url with any other action to load the page and act on it in one step, so no other agent can change the page in between. target: "full-page" (default), "selection" (element picked with the browser's element picker), or "query" (with querySelector). Prefer "query"; "return-element" on broad selectors can be huge. nodeId drives a browser node on filePath's canvas instead (that document must be open in the app). Imported layers are normal canvas nodes: edit them with execute.`,
  {
    action: z
      .enum(["load-page", "import-to-canvas", "screenshot-to-canvas", "return-element", "return-screenshot"])
      .describe("What to do: load-page, import-to-canvas, screenshot-to-canvas, return-element, or return-screenshot."),
    filePath: optionalFilePath.describe(
      "Destination .pen file for import-to-canvas and screenshot-to-canvas (headless or open in the app). Omit for the app's active document.",
    ),
    nodeId: z.string().optional().describe("Id of a browser node in filePath's document to drive, instead of the browser sidebar."),
    target: z.enum(["full-page", "selection", "query"]).optional().describe("What to act on (default full-page)."),
    querySelector: z.string().optional().describe('A CSS selector executed in the page. Required when target is "query".'),
    url: z
      .string()
      .optional()
      .describe('An http(s) or file URL. Required for "load-page"; with any other action, the page is loaded first in the same step.'),
  },
  async ({ filePath: f, url, ...rest }) => {
    const reading = BROWSER_READS.has(rest.action);
    if (rest.nodeId) return browserNode(f, url, rest, reading);
    if (!(await app.available())) throw new AppUnavailableError("browser needs the pen.dev desktop app, which is not running.");
    const dest = reading ? null : await route(f, { write: true }); // resolve the destination before touching the browser

    return withMachineLock(BROWSER_LOCK, async () => {
      const bench = { mode: "app", file: await app.ensureWorkbench(), workbench: true };
      return app.withRendering(async () => {
        if (url && rest.action !== "load-page") {
          const loaded = await browserCall(bench, { action: "load-page", url });
          if (loaded.isError) return fromApp(withHint(loaded, url), bench);
        }
        if (reading) return fromApp(await browserCall(bench, { ...rest, ...(rest.action === "load-page" ? { url } : {}) }), bench);

        const before = readPrinted(await appExec(bench.file, snippets.topLevelIds()), "IDS");
        const res = await browserCall(bench, rest);
        if (res.isError) return fromApp(withHint(res, url), bench);
        const created = readPrinted(await appExec(bench.file, snippets.topLevelIds()), "IDS").filter((id) => !before.includes(id));
        if (!created.length) return fromApp(res, bench, "Nothing new appeared on the canvas to move.");
        const nodes = readPrinted(await appExec(bench.file, snippets.exportNodes(created)), "NODES");
        await appExec(bench.file, snippets.deleteNodes(created));
        return place(dest, carryImages(nodes, path.dirname(bench.file), path.dirname(dest.file)), textOf(res));
      });
    });
  },
);

/** Runs a snippet in an app document; returns the printed text or throws with the app's error. */
async function appExec(file, input) {
  const res = await app.call("execute", { filePath: file, input });
  if (res.isError) throw new Error(textOf(res));
  return textOf(res);
}

/** Rebuilds nodes in the destination document, headless or in the app, and reports the new ids. */
async function place(dest, nodes, what) {
  const input = snippets.insertNodes(nodes);
  const describe = (text) => {
    const created = readPrinted(text, "NEW");
    return `${what}\nMoved into ${dest.file} as: ${created.map((n) => `"${n.id}" (${n.name})`).join(", ")}`;
  };
  if (dest.mode === "app") {
    const res = await appWrite(dest, "execute", { input });
    if (res.isError) return res;
    return { ...res, content: [res.content[0], { type: "text", text: describe(textOf(res)) }, ...res.content.slice(-1)] };
  }
  return pool.use(dest.file, async (session, warnings) => {
    const res = await session.shell.call("execute", { input });
    if (res.error) return fail(res.error, dest.file);
    session.dirty = true;
    designChanged(dest.file);
    if (config.autosave) scheduleHeadlessSave(session);
    return ok(`${describe(res.text)}\n\n${config.autosave ? SAVING_NOTE : NOT_SAVING_NOTE}`, warnings, dest.file);
  });
}

/** A browser node lives in a document, so it is driven in that document's own window. */
async function browserNode(f, url, rest, reading) {
  const target = await route(f, { needsApp: true, tool: "browser", write: !reading });
  return withMachineLock(BROWSER_LOCK, () =>
    app.withRendering(async () => {
      if (url && rest.action !== "load-page") {
        const loaded = await browserCall(target, { action: "load-page", url, nodeId: rest.nodeId });
        if (loaded.isError) return fromApp(withHint(loaded, url), target);
      }
      const args = { ...rest, ...(rest.action === "load-page" ? { url } : {}) };
      return reading ? fromApp(await browserCall(target, args), target) : appWrite(target, "browser", args, browserCall);
    }),
  );
}

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
    ? { ...res, content: [...res.content, { type: "text", text: "Pass url to load the page and act on it in one step." }] }
    : res;

tool(
  "spawn_agents",
  `Split a design task across several designer agents that work in parallel inside the pen.dev app, on a document open there (filePath, or the active document when omitted). pen-multi does not open documents for this; for a file that is not open in the app, use your own subagents on the same filePath instead. Always create one agent fewer than needed: this session does the last part.

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
    const target = await route(f, { needsApp: true, tool: "spawn_agents", write: true });
    return appWrite(target, "spawn_agents", { config: agents });
  },
);

tool(
  "save",
  "Write a .pen document to disk now, whether it is open headlessly or in the pen.dev app, waiting for any background save. Call it before reading or committing a .pen file.",
  { filePath },
  async ({ filePath: f }) => {
    const file = normalize(f);
    if (pool.sessions.has(file)) {
      await saver.flush(file).catch(() => {});
      return pool.use(file, async (session) => ok(await pool.save(session), saveWarning(file), file));
    }
    if ((await app.openFiles({ fresh: true })).has(file)) {
      await saver.flush(file).catch(() => {});
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
    await saver.flush(src).catch(() => {});
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
    designChanged(file); // with save: false, unsaved edits are dropped
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
      .map((h) => {
        const warm = h.file.startsWith("warm:");
        const filePath = warm ? h.file.slice(5) : h.file;
        return { filePath, ...(warm ? { state: "warm" } : {}), agentProject: h.cwd, pid: h.pid, since: h.since, thisAgent: h.pid === process.pid };
      });
    const limits = {
      perAgent: config.maxSessions,
      machineWide: config.globalMaxSessions,
      idleCloseMinutes: config.idleMs / 60_000,
      autosave: config.autosave,
      prewarm: config.prewarm ? `${config.prewarmMs / 60_000} min` : "off",
    };
    const desktopApp = (await app.available())
      ? { running: true, activeDocument: await app.activeFile().catch(() => null), openDocuments: [...(await app.openFiles())] }
      : { running: false };
    return ok(
      JSON.stringify(
        { sessions, machineWide, desktopApp, limits, prewarm: Object.fromEntries(pool.prewarmResults), timings: timings.summary(), pendingSaves: saver.pending(), saveErrors: saver.errors() },
        null,
        2,
      ),
    );
  },
);

designTools = registerDesignTools({ tool, z, route, app, pool, saver, timings, ok, fail, fromApp, textOf, optionalFilePath });
const verifyTools = registerVerifyTools({ tool, z, route, design: designTools, withMachineLock, optionalFilePath, ok, conventions });
registerLintTools({ tool, z, route, design: designTools, executeSnippet, optionalFilePath });
registerImportTools({ tool, z, route, design: designTools, executeSnippet, optionalFilePath, capture: verifyTools.capture, source: verifyTools.source, conventions });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await saver.flushAll();
  await Promise.allSettled([pool.closeAll(), app.close()]);
  fs.rmSync(utilityFile, { force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());

// Start the project's design file editor while the agent is still reading, so its first call
// does not wait for the CLI to start. Delayed so it does not compete with the host starting up.
setTimeout(() => {
  if (!shuttingDown) prewarm({ pool, app, normalize });
}, Number(process.env.PEN_MULTI_PREWARM_DELAY_MS ?? 2000)).unref();
