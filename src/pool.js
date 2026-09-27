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
  prewarm: process.env.PEN_MULTI_PREWARM !== "0",
  prewarmMs: envInt("PEN_MULTI_PREWARM_MINUTES", 3) * 60_000,
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

  /** Live file locks held by any pen-multi process on this machine (not mutexes); stale ones are removed. */
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
      if (!h.pid || !isAlive(h.pid)) fs.rmSync(file, { force: true });
      else if (!h.file?.startsWith("mutex:")) holders.push(h);
    }
    return holders;
  }
}

/**
 * Machine-wide mutex shared by every pen-multi process, e.g. for the app's single integrated
 * browser, so one agent's page load cannot land between another agent's load and read.
 */
export async function withMachineLock(name, fn, { waitMs = config.waitForSlotMs } = {}) {
  const lock = new FileLock(`mutex:${name}`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      lock.acquire();
      break;
    } catch (err) {
      if (!/being edited by another agent/.test(err.message)) throw err;
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${waitMs / 1000}s waiting for the shared ${name}, held by another agent.`);
      }
      await sleep(250);
    }
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

class Session {
  constructor({ file, inPath, shell }) {
    this.file = file;
    this.inPath = inPath;
    this.lock = new FileLock(file);
    this.shell = shell ?? new PenShell({ inPath, outPath: file });
    this.dirty = false;
    this.lastUsed = Date.now();
    this.openedAt = new Date().toISOString();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statKey = (file) => {
  const st = fs.statSync(file);
  return `${st.mtimeMs}:${st.size}`;
};

export class SessionPool {
  constructor({ saver } = {}) {
    this.saver = saver; // background saves to flush before a session closes
    this.sessions = new Map();
    this.pending = new Map();
    // file -> an editor started ahead of use, without the file lock (see prewarm).
    this.warm = new Map();
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
    const warm = this.#takeWarm(file);
    let shell;
    try {
      new FileLock(file).assertNotHeldElsewhere(); // fail fast, before waiting for a slot
      if (warm && source === file && (await warm.ready) && !warm.shell.stopped && statKey(file) === warm.stat) {
        warm.marker.release(); // its slot passes to the session below
        shell = warm.shell;
      }
    } finally {
      if (warm && !shell) await this.#discardWarm(warm);
    }
    const session = new Session({ file, inPath: source, shell });
    try {
      await this.#makeRoom();
      session.lock.acquire();
    } catch (err) {
      shell?.kill(); // an adopted warm editor would otherwise outlive the failed open
      throw err;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!shell) await session.shell.start();
    } catch (err) {
      if (shell) shell.kill();
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

  /**
   * Starts an editor for `file` before any call needs it, so the first call skips CLI startup.
   * It holds only a "warm:" marker (counted toward the machine-wide limit, one per file across
   * processes), never the file lock, so it blocks no one. Returns whether an editor was started.
   */
  async prewarm(file) {
    if (!config.prewarm || !fs.existsSync(file)) return false;
    if (this.sessions.has(file) || this.pending.has(file) || this.warm.has(file)) return false;
    if (this.sessions.size >= config.maxSessions || FileLock.live().length >= config.globalMaxSessions) return false;
    try {
      new FileLock(file).assertNotHeldElsewhere();
    } catch {
      return false;
    }
    const marker = new FileLock(`warm:${file}`);
    try {
      marker.acquire();
    } catch {
      return false; // another process pre-warmed it
    }
    const entry = { marker, stat: statKey(file), shell: new PenShell({ inPath: file, outPath: file }) };
    entry.ready = entry.shell.start().then(
      () => (entry.started = true),
      () => false,
    );
    this.warm.set(file, entry);
    entry.timer = setTimeout(() => this.#closeWarm(file), config.prewarmMs);
    entry.timer.unref();
    entry.shell.onExit = () => {
      if (this.warm.get(file) === entry) this.#closeWarm(file);
    };
    if (!(await entry.ready)) {
      if (this.warm.get(file) === entry) await this.#closeWarm(file);
      return false;
    }
    return true;
  }

  /** Removes the warm editor for `file` from the pool and returns it, or null. */
  #takeWarm(file) {
    const entry = this.warm.get(file);
    if (!entry) return null;
    this.warm.delete(file);
    clearTimeout(entry.timer);
    return entry;
  }

  async #discardWarm(entry) {
    entry.shell.onExit = null;
    await entry.shell.close().catch(() => {});
    entry.marker.release();
  }

  async #closeWarm(file) {
    const entry = this.#takeWarm(file);
    if (entry) await this.#discardWarm(entry);
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
    if (save) await this.saver?.flush(file).catch(() => {}); // a failed save is kept by the saver
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
    await Promise.allSettled([...this.sessions.keys()].map((f) => this.close(f)).concat([...this.warm.keys()].map((f) => this.#closeWarm(f))));
  }

  list() {
    const warm = [...this.warm].map(([file, w]) => ({ filePath: file, state: w.started ? "warm" : "starting" }));
    return [...this.sessions.values()].map((s) => ({
      filePath: s.file,
      state: "open",
      seededFrom: s.inPath && s.inPath !== s.file ? s.inPath : undefined,
      unsavedChanges: s.dirty,
      busy: this.busy(s.file),
      openedAt: s.openedAt,
      idleSeconds: Math.round((Date.now() - s.lastUsed) / 1000),
    })).concat(warm);
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

      const [warm] = this.warm.keys();
      if (warm) {
        await this.#closeWarm(warm); // an editor nobody uses yet goes first
        continue;
      }
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
