// Tier 2 eval tasks. Each builds its workspace (a .pen made by import_ui from a fixture page, and
// the code the agent starts from), gives a prompt, and checks the result with verify itself.
import fs from "node:fs";
import path from "node:path";

const FIX = new URL("./fixtures/", import.meta.url).pathname;
const stub = `<!doctype html><meta charset="utf-8"><body style="margin:0;font-family:Arial"><h1>TODO</h1></body>`;
const inject = (html) => html.replace("border-radius:12px", "border-radius:4px").replace("gap:12px;align-items", "gap:24px;align-items").replace(">Sign out<", ">Log out<");

export const TASKS = {
  port: {
    code: () => stub,
    design: "profile.html",
    prompt: (w) => `Implement the design frame "Profile" of ${w.pen} in ${w.page} (plain HTML/CSS, one file) so that pen-multi verify against file://${w.page} reports MATCH. Use the pen-multi tools. Stop when verify reports MATCH.`,
    direction: "design-to-code",
  },
  "design-update": {
    code: () => fs.readFileSync(path.join(FIX, "profile-changed.html"), "utf8"),
    design: "profile.html",
    prompt: (w) => `The page ${w.page} changed. Update the design frame "Profile" in ${w.pen} so it matches the page again: pen-multi verify against file://${w.page} must report MATCH. Edit the design with pen-multi tools; do not edit the page.`,
    direction: "code-to-design",
  },
  fix: {
    code: () => inject(fs.readFileSync(path.join(FIX, "profile.html"), "utf8")),
    design: "profile.html",
    prompt: (w) => `${w.page} implements the design frame "Profile" of ${w.pen} but verify says it differs. Fix the page until pen-multi verify against file://${w.page} reports MATCH. Do not edit the design.`,
    direction: "design-to-code",
  },
};
export const fixture = (name) => path.join(FIX, name);
