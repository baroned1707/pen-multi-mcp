#!/usr/bin/env node
// pen-multi command line, for a person (not for agents):
//   pen-multi trust <project folder> "<command>"   allow a snapshot command for that project
//   pen-multi report [--days 7] [--project <folder name>] [--json]   how pen-multi performed
import os from "node:os";
import path from "node:path";
import { readEvents } from "../src/events.js";
import { renderSummary, summarize } from "../src/report.js";
import { trust } from "../src/snapshot/trust.js";

const [cmd, project, command] = process.argv.slice(2);
const home = process.env.PEN_MULTI_HOME ?? path.join(os.homedir(), ".pen-multi");
const opt = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
if (cmd === "report") {
  const days = Number(opt("days") ?? 7);
  const { events, capped } = readEvents(home, { days, project: opt("project") });
  const s = summarize(events);
  console.log(process.argv.includes("--json") ? JSON.stringify(s, null, 1) : renderSummary(s, { days, capped }).join("\n"));
} else if (cmd === "trust" && project && command) {
  const h = trust(home, project, command);
  console.log(`Trusted for ${path.resolve(project)}: ${command}\n(sha256 ${h.slice(0, 12)}…, stored in ${path.join(home, "trusted.json")})`);
} else {
  console.error('Usage: pen-multi trust <project folder> "<command>"\n       pen-multi report [--days 7] [--project <folder name>] [--json]');
  process.exit(2);
}
