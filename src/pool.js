import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PenShell } from "./shell.js";

const envInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const home = process.env.PEN_MULTI_HOME ?? path.join(os.homedir(), ".pen-multi");

export const config = {
  maxSessions: envInt("PEN_MULTI_MAX_SESSIONS", 4),
  globalMaxSessions: envInt("PEN_MULTI_GLOBAL_MAX_SESSIONS", 8),
  idleMs: envInt("PEN_MULTI_IDLE_MINUTES", 15) * 60_000,
  waitForSlotMs: envInt("PEN_MULTI_WAIT_FOR_SLOT_SECONDS", 120) * 1000,
  autosave: process.env.PEN_MULTI_AUTOSAVE !== "0",
  home,
  lockDir: path.join(home, "locks"),
  cacheDir: path.join(home, "cache"),
};

/**
 * Resolves a tool's filePath. Relative paths resolve against this server's working directory,
 * which Claude Code sets to the agent's project root. Symlinks are resolved so one file always
 * maps to one editor and one lock (/tmp and /private/tmp are the same place on macOS).
 */
export const normalize = (p) => {
  if (!p) throw new Error("filePath is required");
  const expanded = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
  if (!expanded.endsWith(".pen")) throw new Error(`filePath must end with .pen: ${p}`);
  return realpathLenient(path.resolve(process.cwd(), expanded));
};

// For a file that does not exist yet, resolve its nearest existing parent.
function realpathLenient(p) {
  let dir = p;
  const tail = [];
  while (!fs.existsSync(dir)) {
    tail.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) return p;
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...tail);
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

const describeHolder = (h) => `${h.file} (agent in ${h.cwd ?? "unknown project"}, pid ${h.pid}, since ${h.since})`;

// Cross-process lock: every agent session runs its own pen-multi-mcp process,
// so two of them must not hold editors on the same file.
export class FileLock {
  constructor(file) {
    this.path = path.join(config.lockDir, createHash("sha1").update(file).digest("hex") + ".lock");
    this.file = file;
  }

  acquire() {
    fs.mkdirSync(config.lockDir, { recursive: true });
    const body = JSON.stringify({ pid: process.pid, cwd: process.cwd(), file: this.file, since: new Date().toISOString() });
    try {
      fs.writeFileSync(this.path, body, { flag: "wx" });
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    this.assertNotHeldElsewhere();
    fs.writeFileSync(this.path, body); // stale lock from a dead process
  }

  assertNotHeldElsewhere() {
    const holder = readJson(this.path);
    if (holder.pid && holder.pid !== process.pid && isAlive(holder.pid)) {
      throw new Error(
        `${this.file} is being edited by another agent: ${describeHolder(holder)}. ` +
          `Wait for it to finish, or fork_version to a new path and work on the copy.`,
      );
    }
  }

  release() {
    if (readJson(this.path).pid === process.pid) fs.rmSync(this.path, { force: true });
  }

  /** Live locks held by any pen-multi process on this machine; stale ones are removed. */
  static live() {
    let names = [];
    try {
      names = fs.readdirSync(config.lockDir).filter((n) => n.endsWith(".lock"));
    } catch {
      return [];
    }
    const holders = [];
    for (const n of names) {
      const file = path.join(config.lockDir, n);
      const h = readJson(file);
      if (h.pid && isAlive(h.pid)) holders.push(h);
      else fs.rmSync(file, { force: true });
    }
    return holders;
  }
}

// Best effort: the desktop app only exposes the file each window was launched with.
function openInDesktopApp(file) {
  try {
    const ps = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 32 << 20 });
    const uri = "file://" + encodeURI(file);
    return ps.split("\n").some((l) => l.includes("Pen Helper (Renderer)") && l.includes(`"fileURI":"${uri}"`));
  } catch {
    return false;
  }
}

class Session {
  constructor({ file, inPath }) {
    this.file = file;
    this.inPath = inPath;
    this.lock = new FileLock(file);
    this.shell = new PenShell({ inPath, outPath: file });
    this.dirty = false;
    this.lastUsed = Date.now();
    this.openedAt = new Date().toISOString();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SessionPool {
  constructor() {
    this.sessions = new Map();
    this.pending = new Map();
    // file -> number of tool calls using it. Counted from the moment a call arrives, before its
    // file is even open, so a file can never be evicted between being opened and being used.
    this.inUse = new Map();
    this.opening = Promise.resolve(); // opens run one at a time so slot accounting stays accurate
    this.sweeper = setInterval(() => this.#sweepIdle(), 60_000);
    this.sweeper.unref();
  }

  /**
   * Runs fn(session, warnings) with the file's session leased, opening it if needed.
   * `inPath` seeds a new file from another .pen.
   */
  async use(file, fn, { inPath } = {}) {
    this.inUse.set(file, (this.inUse.get(file) ?? 0) + 1);
    try {
      const { session, warnings } = await this.#get(file, inPath);
      try {
        return await fn(session, warnings);
      } finally {
        session.lastUsed = Date.now();
      }
    } finally {
      const n = this.inUse.get(file) - 1;
      if (n > 0) this.inUse.set(file, n);
      else this.inUse.delete(file);
    }
  }

  busy(file) {
    return this.inUse.has(file);
  }

  async #get(file, inPath) {
    let existing = this.sessions.get(file);
    if (existing?.shell.stopped) {
      this.sessions.delete(file);
      existing.lock.release();
      existing = undefined;
    }
    if (existing) {
      if (inPath && inPath !== existing.inPath) {
        throw new Error(`${file} is already open (seeded from ${existing.inPath ?? "itself"}); close it first.`);
      }
      existing.lastUsed = Date.now();
      return { session: existing, warnings: [] };
    }
    if (this.pending.has(file)) return this.pending.get(file);
    const run = () => this.#open(file, inPath);
    const opening = this.opening.then(run, run).finally(() => this.pending.delete(file));
    this.opening = opening.catch(() => {});
    this.pending.set(file, opening);
    return opening;
  }

  async #open(file, inPath) {
    const warnings = [];
    const source = inPath ?? (fs.existsSync(file) ? file : undefined);
    if (source) {
      if (!fs.existsSync(source)) throw new Error(`Source file not found: ${source}`);
      if (fs.statSync(source).size === 0) {
        warnings.push(
          `${source} is 0 bytes on disk, so it opens as an empty document. If the pen.dev desktop app shows content for it, ` +
            `that content is unsaved - save it in the app (Cmd+S) before editing here, or it will be overwritten.`,
        );
      }
    }
    if (openInDesktopApp(file)) {
      warnings.push(
        `${file} is also open in the pen.dev desktop app. Edits saved here are not reloaded by the app, and saving in the app will overwrite them.`,
      );
    }

    new FileLock(file).assertNotHeldElsewhere(); // fail fast, before waiting for a slot
    await this.#makeRoom();
    const session = new Session({ file, inPath: source });
    session.lock.acquire();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await session.shell.start();
    } catch (err) {
      session.lock.release();
      throw err;
    }
    session.shell.onExit = () => {
      // A replacement session for the same file shares this pid's lock; leave it alone.
      if (this.sessions.get(file) !== session) return;
      this.sessions.delete(file);
      session.lock.release();
    };
    this.sessions.set(file, session);
    return { session, warnings };
  }

  async save(session) {
    const res = await session.shell.call("save");
    if (res.error) throw new Error(`save failed for ${session.file}: ${res.error}`);
    session.dirty = false;
    return res.text;
  }

  async close(file, { save = true } = {}) {
    const session = this.sessions.get(file);
    if (!session) return false;
    this.sessions.delete(file);
    try {
      if (save && session.dirty) await this.save(session);
    } finally {
      await session.shell.close();
      session.lock.release();
    }
    return true;
  }

  async closeAll() {
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.sessions.keys()].map((f) => this.close(f)));
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      filePath: s.file,
      seededFrom: s.inPath && s.inPath !== s.file ? s.inPath : undefined,
      unsavedChanges: s.dirty,
      busy: this.busy(s.file),
      openedAt: s.openedAt,
      idleSeconds: Math.round((Date.now() - s.lastUsed) / 1000),
    }));
  }

  /**
   * Frees a slot under both limits: this server's maxSessions and the machine-wide
   * globalMaxSessions shared by all agents. Only idle sessions of this server are evicted;
   * when every candidate is busy, wait for one to finish rather than pull a file from under an agent.
   */
  async #makeRoom() {
    const deadline = Date.now() + config.waitForSlotMs;
    for (;;) {
      const localFull = this.sessions.size >= config.maxSessions;
      const globalFull = FileLock.live().length >= config.globalMaxSessions;
      if (!localFull && !globalFull) return;

      const [idle] = [...this.sessions.values()].filter((s) => !this.busy(s.file)).sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle) {
        await this.close(idle.file);
        continue;
      }
      if (Date.now() > deadline) {
        const holders = FileLock.live().map((h) => `- ${describeHolder(h)}`).join("\n");
        throw new Error(
          `No free pen editor slot after ${config.waitForSlotMs / 1000}s ` +
            `(${localFull ? `this agent has ${config.maxSessions} files open` : `${config.globalMaxSessions} files open machine-wide`}). ` +
            `Close files you are done with (close_file), or raise PEN_MULTI_MAX_SESSIONS / PEN_MULTI_GLOBAL_MAX_SESSIONS.\nOpen files:\n${holders}`,
        );
      }
      await sleep(500);
    }
  }

  async #sweepIdle() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (!this.busy(s.file) && now - s.lastUsed > config.idleMs) await this.close(s.file).catch(() => {});
    }
  }
}
