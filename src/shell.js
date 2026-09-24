import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PROMPT = /(?:^|\n)pen > $/;
// Startup includes an auth check and CanvasKit init: ~3 s normally, far longer on a loaded machine.
const STARTUP_TIMEOUT_MS = Number(process.env.PEN_MULTI_STARTUP_TIMEOUT_MS ?? 180_000);
const CALL_TIMEOUT_MS = Number(process.env.PEN_MULTI_CALL_TIMEOUT_MS ?? 300_000);

export function resolveCliEntry() {
  if (process.env.PEN_CLI_PATH) return process.env.PEN_CLI_PATH;
  const pkg = require.resolve("@pen.dev/cli/package.json");
  return path.join(path.dirname(pkg), "dist", "index.mjs");
}

/** Version of the CLI in use; keys the shared read_skill/get_style cache. */
export function cliVersion() {
  try {
    const pkg = path.join(path.dirname(resolveCliEntry()), "..", "package.json");
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const stripAnsi = (s) => s.replace(ANSI, "");

// Encodes one tool call as a single shell line. JSON is a valid JS object literal,
// and escaping U+2028/U+2029 keeps readline from splitting the line.
export function encodeCall(tool, args) {
  const json = args && Object.keys(args).length ? JSON.stringify(args) : "";
  return `${tool}(${json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")})`;
}

/**
 * One long-lived `pen interactive` headless process bound to a single .pen file.
 * Calls are serialized: the shell answers one command at a time.
 */
export class PenShell {
  constructor({ inPath, outPath }) {
    this.inPath = inPath;
    this.outPath = outPath;
    this.stdout = "";
    this.stderr = "";
    this.queue = Promise.resolve();
    this.exited = false;
    this.onExit = null;
  }

  async start() {
    const args = [resolveCliEntry(), "interactive", "-o", this.outPath];
    if (this.inPath) args.push("-i", this.inPath);
    this.proc = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.dirname(this.outPath), // relative Export() paths land next to the file
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    this.proc.stdout.on("data", (d) => (this.stdout += stripAnsi(d.toString())));
    this.proc.stderr.on("data", (d) => (this.stderr += stripAnsi(d.toString())));
    this.proc.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
      this.onExit?.(code);
    });

    try {
      await this.#waitForPrompt(STARTUP_TIMEOUT_MS);
    } catch (err) {
      this.kill();
      const detail = this.stderr.trim() || this.stdout.trim();
      throw new Error(`pen CLI failed to start for ${this.outPath}: ${err.message}\n${detail}`);
    }
    this.stdout = "";
    this.stderr = "";
  }

  /** Runs one tool call; resolves to { text, error } where error is the shell's error text, if any. */
  call(tool, args) {
    const run = async () => {
      if (this.exited) throw new Error(`pen session for ${this.outPath} has exited (code ${this.exitCode})`);
      this.stdout = "";
      this.stderr = "";
      this.proc.stdin.write(encodeCall(tool, args) + "\n");
      try {
        await this.#waitForPrompt(CALL_TIMEOUT_MS);
      } catch (err) {
        // The shell may still answer later and would mix that output into the next call.
        this.kill();
        throw new Error(
          `${tool} on ${this.outPath} did not finish (${err.message}). The editor was stopped; changes since the last save are lost.`,
        );
      }
      await new Promise((r) => setTimeout(r, 20)); // let trailing stderr flush
      const text = this.stdout.replace(PROMPT, "").trim();
      return { text, error: extractError(this.stderr) };
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async close() {
    if (this.exited) return;
    await this.queue;
    this.proc.stdin.write("exit()\n");
    await Promise.race([
      new Promise((r) => this.proc.once("exit", r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    this.kill();
  }

  /** True once the process has exited or been told to stop; such a shell must not be reused. */
  get stopped() {
    return this.exited || Boolean(this.proc?.killed);
  }

  kill() {
    if (!this.exited) this.proc.kill("SIGTERM");
  }

  #waitForPrompt(timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (PROMPT.test(this.stdout)) return resolve();
        if (this.exited) return reject(new Error(`process exited (code ${this.exitCode})`));
        if (Date.now() - started > timeoutMs) return reject(new Error(`timed out after ${timeoutMs}ms`));
        setTimeout(tick, 25);
      };
      tick();
    });
  }
}

// The shell logs "[ERROR] ..." diagnostics and then prints the user-facing "Error: ..." message.
// Only that final message marks a failed call; other stderr output (logs, runtime warnings) is not a failure.
export function extractError(stderr) {
  const match = /^Error: /m.exec(stderr);
  return match ? stderr.slice(match.index + match[0].length).trim() : null;
}
