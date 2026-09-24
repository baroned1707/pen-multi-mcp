#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { toContent } from "./format.js";
import { FileLock, SessionPool, config, normalize } from "./pool.js";
import { cliVersion } from "./shell.js";

const pool = new SessionPool();

const INSTRUCTIONS = `Headless pen.dev editor for .pen design files. The pen.dev desktop app does NOT need to be running.

- Every file runs in its own isolated headless editor, keyed by its resolved absolute path. Several agents and projects can work at the same time; each response starts with "File: <path>" so you can confirm which file it acted on.
- Relative filePaths resolve against this agent's working directory (${process.cwd()}). Prefer absolute paths when working outside it.
- A file can be edited by only one agent at a time. If another agent holds it, the error names that agent's project; fork_version to a new path to work in parallel.
- Changes are ${config.autosave ? "saved to disk automatically after every successful execute call" : "kept in memory until you call save"}.
- To try a variation without touching the original, call fork_version to copy the file to a new path, then work on the copy.
- .pen files are encrypted: never Read/Grep them, only use these tools.
- Call read_skill before designing, and follow the execute rules it describes.
- Do not edit a file here while it is also open in the pen.dev desktop app: the two editors overwrite each other.
- Global variables set in execute live only while the file stays open. Idle files are closed after ${config.idleMs / 60_000} minutes or when editor slots run out; after that, re-read ids with Get instead of relying on old globals. Call close_file when you are done with a file to free its slot for other agents.`;

const server = new McpServer({ name: "pen-multi", version: "0.1.0" }, { instructions: INSTRUCTIONS });

const filePath = z
  .string()
  .describe("Path to the .pen file: absolute, or relative to this agent's working directory. Identifies the editor session.");

const ok = (text, warnings = [], file) => ({
  content: toContent(
    [file && `File: ${file}`, ...warnings.map((w) => `WARNING: ${w}`), text].filter(Boolean).join("\n\n"),
  ),
});
const fail = (text, file) => ({ content: [{ type: "text", text: file ? `File: ${file}\n\n${text}` : text }], isError: true });

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
  "Load visual styles for designing .pen files. Call without a name to list styles, then with a name to load one.",
  { name: z.string().optional().describe("Style name from the list.") },
  ({ name }) => staticCall("get_style", name ? { name } : undefined),
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
  "Get the document state of one .pen file: top-level nodes, reusable components, selection. Opens the file if needed.",
  { filePath },
  async ({ filePath: f }) => {
    const file = normalize(f);
    return pool.use(file, async (session, warnings) => {
      const res = await session.shell.call("get_app_state");
      return res.error ? fail(res.error, file) : ok(res.text, warnings, file);
    });
  },
);

tool(
  "execute",
  "Run a JavaScript snippet against one .pen file (Insert/Update/Get/Print/TakeScreenshot/Export/...; see read_skill execute.md). Opens the file if needed. On failure, retry with editId + edits instead of resending the snippet.",
  {
    filePath,
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
    const file = normalize(f);
    return pool.use(file, async (session, warnings) => {
      const res = await session.shell.call("execute", input ? { input } : { editId, edits });
      if (res.error) return fail(res.error, file);
      session.dirty = true;
      if (config.autosave) await pool.save(session);
      return ok(res.text, warnings, file);
    });
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
  "List the .pen files this agent has open, and every file open by any agent on this machine.",
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
    return ok(JSON.stringify({ sessions, machineWide, limits }, null, 2));
  },
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await pool.closeAll();
  fs.rmSync(utilityFile, { force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
