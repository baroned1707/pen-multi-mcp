// Snapshots from anything: a file written by some tool, or a command the project provides (a
// Flutter integration test, a desktop accessibility dump, …). The command gets where to write and
// what to capture through environment variables; the result is validated against the schema.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateSnapshot } from "../../snapshot/schema.js";
import { isTrusted, trustLine } from "../../snapshot/trust.js";

export class SourceError extends Error {}

function load(file, what) {
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new SourceError(`${what} did not produce a readable snapshot at ${file}: ${err.message}`);
  }
  const errors = validateSnapshot(snap);
  if (errors.length) throw new SourceError(`${what} is not a valid snapshot (schema: MCP resource pen-multi://snapshot-schema, docs/snapshot-schema.json):\n${errors.map((e) => `- ${e}`).join("\n")}`);
  return snap;
}

/** A snapshot file; a relative screenshot path is taken from the snapshot's folder. */
export function captureFile({ path: p }, { cwd = process.cwd() } = {}) {
  const file = path.resolve(cwd, p);
  const snap = load(file, `snapshot file ${p}`);
  if (snap.screenshot && !path.isAbsolute(snap.screenshot)) snap.screenshot = path.resolve(path.dirname(file), snap.screenshot);
  return { snapshot: { ...snap, fields: snap.fields ?? [], request: { kind: "file", path: p } } };
}

/**
 * Runs a trusted command that writes a snapshot. Off unless the command is in the person's trust
 * list for this project, or the server runs with PEN_MULTI_COMMANDS=1.
 */
export async function captureCommand({ run, cwd: runCwd, timeoutMs = 120_000 }, { home, cwd = process.cwd(), width, height, theme, target, state, out }) {
  const dir = path.resolve(cwd, runCwd ?? ".");
  if (process.env.PEN_MULTI_COMMANDS !== "1" && !isTrusted(home, cwd, run)) {
    throw new SourceError(`the command source is off for untrusted commands. To allow this one for this project, the user runs:\n  ${trustLine(cwd, run)}\n(or starts the server with PEN_MULTI_COMMANDS=1). pen-multi never trusts a command on its own.`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const snapshotOut = `${out}.json`, screenshotOut = `${out}.png`;
  for (const f of [snapshotOut, screenshotOut]) fs.rmSync(f, { force: true });
  const env = { ...process.env, PEN_SNAPSHOT_OUT: snapshotOut, PEN_SCREENSHOT_OUT: screenshotOut, PEN_WIDTH: String(Math.round(width)), PEN_HEIGHT: String(Math.round(height)), PEN_THEME: theme ?? "", PEN_TARGET: target ?? "", PEN_STATE: state ?? "" };
  const { code, output } = await new Promise((resolve) => {
    const child = spawn(run, { cwd: dir, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (d) => (output = (output + d).slice(-4000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  if (code !== 0) throw new SourceError(`the snapshot command exited with ${code}:\n${output.trim().split("\n").slice(-12).join("\n")}`);
  const snap = load(snapshotOut, "the snapshot command");
  if (!snap.screenshot && fs.existsSync(screenshotOut)) snap.screenshot = screenshotOut;
  return { snapshot: { ...snap, fields: snap.fields ?? [], request: { kind: "command", run } } };
}
