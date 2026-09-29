#!/usr/bin/env node
// pen-multi command line, for a person (not for agents):
//   pen-multi trust <project folder> "<command>"   allow a snapshot command for that project
import os from "node:os";
import path from "node:path";
import { trust } from "../src/snapshot/trust.js";

const [cmd, project, command] = process.argv.slice(2);
const home = process.env.PEN_MULTI_HOME ?? path.join(os.homedir(), ".pen-multi");
if (cmd === "trust" && project && command) {
  const h = trust(home, project, command);
  console.log(`Trusted for ${path.resolve(project)}: ${command}\n(sha256 ${h.slice(0, 12)}…, stored in ${path.join(home, "trusted.json")})`);
} else {
  console.error('Usage: pen-multi trust <project folder> "<command>"');
  process.exit(2);
}
