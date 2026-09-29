// doctor: is this project set up for design ↔ code work? Each check says ✅ / ⚠️ / ❌ and how to
// fix it. It changes nothing: routes, markers and trust are the project's and the user's to set.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stateHint } from "../design/overview.js";
import { projectMapping } from "../mapping/index.js";
import { SYNC_DIR } from "../sync/index.js";

const git = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

async function opens(url, ms = 4000) {
  if (/^file:/i.test(url)) return fs.existsSync(new URL(url)) ? "ok" : "missing file";
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(ms), redirect: "follow" });
    return res.status < 400 ? "ok" : `HTTP ${res.status}`;
  } catch (err) {
    return err.name === "TimeoutError" ? "no answer in 4 s" : err.cause?.code ?? err.message;
  }
}

export function registerDoctorTool({ tool, z, route, design, conventions, optionalFilePath }) {
  tool(
    "doctor",
    "Use when starting design ↔ code work in a project, or when verify, inspect or sync_status say something is missing: checks the git repository, .pen-multi.json (routes that answer, states, screen naming), code markers and component mapping, the token file, and where sync records go — each with how to fix it. Changes nothing.",
    { filePath: optionalFilePath },
    async ({ filePath: f }) => {
      const target = await route(f);
      const { analysis } = await design.analysisOf(target);
      const conv = conventions(target.file);
      const cwd = process.cwd();
      const lines = [`# doctor: ${target.file}`, ""];
      const ok = (m) => lines.push(`✅ ${m}`), warn = (m) => lines.push(`⚠️ ${m}`), bad = (m) => lines.push(`❌ ${m}`);
      let problems = 0;

      // Git: markers are searched in the repository; sync records are committed.
      const inGit = git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
      if (inGit) ok(`${cwd} is a git repository.`);
      else (problems++, bad(`${cwd} is not inside a git repository: code markers are not searched and sync records cannot be tied to a commit. Start the agent in the project's repository.`));

      // .pen-multi.json
      const confPath = path.join(path.dirname(target.file), ".pen-multi.json");
      const frames = analysis.matrix.rows.flatMap((r) => Object.values(r.cells).flat().map((c) => ({ ...c, row: r })));
      if (!fs.existsSync(confPath)) {
        problems++;
        bad(`No .pen-multi.json next to the .pen: verify needs each screen's page. Add { "baseUrl": "http://localhost:5173", "routes": { "${analysis.matrix.rows[0]?.screen ?? "Home"}": "/" } }.`);
      } else {
        const routes = conv.routes ?? {};
        const screens = analysis.matrix.rows.filter((r) => [r.screen, r.code, ...Object.values(r.cells).flat().map((c) => c.name)].some((k) => k && routes[k]));
        (screens.length === analysis.matrix.rows.length ? ok : warn)(`Routes for ${screens.length} of ${analysis.matrix.rows.length} screens.${screens.length < analysis.matrix.rows.length ? ` Missing: ${analysis.matrix.rows.filter((r) => !screens.includes(r)).slice(0, 6).map((r) => r.screen).join(", ")}${analysis.matrix.rows.length - screens.length > 6 ? ", …" : ""}.` : ""}`);
        const sample = Object.values(routes).slice(0, 3);
        for (const r of sample) {
          const url = /^[a-z]+:/i.test(r) ? r : conv.baseUrl ? `${conv.baseUrl.replace(/\/+$/, "")}/${r.replace(/^\/+/, "")}` : null;
          if (!url) {
            problems++;
            bad(`Route "${r}" needs a baseUrl in .pen-multi.json.`);
            continue;
          }
          const res = await opens(url);
          if (res === "ok") ok(`${url} answers.`);
          else (problems++, bad(`${url}: ${res}. Start the dev server (pen-multi never starts it), or fix baseUrl.`));
        }
        const stateless = analysis.matrix.rows.filter((r) => r.state && !Object.keys(conv.states ?? {}).some((k) => k === `${r.screen} — ${r.state}` || Object.values(r.cells).flat().some((c) => c.name === k)));
        if (stateless.length) warn(`${stateless.length} state row(s) with no states entry to put the app in that state (${stateless.slice(0, 4).map((r) => `${r.screen} — ${r.state}`).join(", ")}): add { "states": { "<Screen — state>": { "mocks": [...], "steps": [...] } } } or pass source.mocks.`);
      }
      const hint = stateHint(analysis.matrix.rows);
      if (hint) warn(hint.replace(/^⚠ /, ""));

      // Markers and component mapping.
      const mapping = projectMapping({ penFile: target.file, conv, components: analysis.components.filter((c) => c.instances > 0) });
      const markers = mapping.index.markers.size;
      if (!inGit) {
        // said above
      } else if (!markers) {
        problems++;
        bad(`No code markers found: verify matches by text and position only, and findings have no file:line. Mark sections, texts and component roots with data-pen="<address or id>" (web) or "pen:<…>" (testID, Key, accessibility id).`);
      } else {
        const screensMarked = frames.filter((c) => [...mapping.index.markers.keys()].some((m) => m === c.id || m === c.name || m.startsWith(`${c.name}/`))).length;
        ok(`${markers} markers in ${mapping.index.files} source files; ${screensMarked} of ${frames.length} frames are marked by id or name (others match by address suffix, text and position).`);
      }
      const used = analysis.components.filter((c) => c.instances > 0);
      if (used.length) {
        const mapped = used.length - mapping.components.unmapped.length;
        (mapping.components.unmapped.length ? warn : ok)(`${mapped} of ${used.length} components in use map to code.${mapping.components.unmapped.length ? ` Not mapped (most used first): ${mapping.components.unmapped.slice(0, 5).map((c) => `${c.name} ×${c.instances} (id ${c.id})`).join(", ")} — mark each definition with data-pen="<id>", or add .pen-multi.json "components".` : ""}`);
        for (const [id, c] of mapping.components) if (c.problem) (problems++, bad(`.pen-multi.json components ${id}: ${c.problem}.`));
      }

      // Tokens.
      if (conv.tokens?.file) {
        const tf = path.resolve(path.dirname(target.file), conv.tokens.file);
        if (fs.existsSync(tf)) ok(`Token file ${conv.tokens.file} (inspect and verify show code token names; tokens compare checks values).`);
        else (problems++, bad(`.pen-multi.json tokens.file ${conv.tokens.file} does not exist.`));
      } else warn(`No token file: inspect shows design variables, not the code's token names. Add .pen-multi.json { "tokens": { "file": "<path to the token file>" } } (CSS custom properties or token JSON).`);

      // Sync records are meant to be committed.
      const probe = path.join(path.dirname(target.file), SYNC_DIR, "x.json");
      if (inGit && git(["check-ignore", "-q", probe], cwd) !== null) (problems++, bad(`${path.relative(cwd, path.dirname(probe))}/ is gitignored: sync records must be committed so every agent and machine knows where design and code stand.`));
      else if (inGit) ok(`Sync records go to ${path.relative(cwd, path.dirname(probe)) || SYNC_DIR}/ and are committed with the code.`);
      lines.push(`ℹ️ Other platforms (Flutter, desktop, …): pass source { kind: "file" } or { kind: "command" } writing a snapshot per the resource pen-multi://snapshot-schema; a command runs only after the user trusts it.`);

      lines.push("", problems ? `Next: fix the ❌ items (${problems}), then run doctor again.` : "Next: sync_status for where design and code stand, or the port-design / design-from-code prompts.");
      return design.wrap(target, lines);
    },
  );
}
