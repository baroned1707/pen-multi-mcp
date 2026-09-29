// Which snapshot commands may run, per project: kept in ~/.pen-multi/trusted.json, outside every
// repository, so a repository cannot trust its own commands. Only a person adds entries
// (`pen-multi trust <project> "<command>"`); pen-multi only reads them.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const commandHash = (command) => createHash("sha256").update(String(command)).digest("hex");
const file = (home) => path.join(home, "trusted.json");

function read(home) {
  try {
    return JSON.parse(fs.readFileSync(file(home), "utf8"));
  } catch {
    return { projects: {} };
  }
}

/** Whether `command` is trusted for `project` (an absolute folder; its parents count too). */
export function isTrusted(home, project, command) {
  const data = read(home);
  const h = commandHash(command);
  for (let dir = path.resolve(project); ; dir = path.dirname(dir)) {
    if ((data.projects?.[dir] ?? []).includes(h)) return true;
    if (dir === path.dirname(dir)) return false;
  }
}

/** Adds a trusted command for a project (used by the CLI, by a person). */
export function trust(home, project, command) {
  const data = read(home);
  const dir = path.resolve(project);
  const list = new Set(data.projects?.[dir] ?? []);
  list.add(commandHash(command));
  data.projects = { ...data.projects, [dir]: [...list] };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file(home), `${JSON.stringify(data, null, 1)}\n`);
  return commandHash(command);
}

/** The line a person runs to trust a command (what doctor and errors print). */
const BIN = new URL("../../bin/pen-multi.js", import.meta.url).pathname;
export const trustLine = (project, command) => `node ${JSON.stringify(BIN)} trust ${JSON.stringify(path.resolve(project))} ${JSON.stringify(command)}`;
