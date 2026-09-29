// A throwaway copy of a real app for one eval run: its committed state cloned into a temp folder
// (the repository itself is never written), dependencies linked, the app started on a free port.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const home = (p) => p.replace(/^~(?=\/)/, os.homedir());

export function loadApp(name) {
  const file = new URL(`../apps/${name}.json`, import.meta.url);
  const app = JSON.parse(fs.readFileSync(file, "utf8"));
  return { name, ...app, repo: home(app.repo) };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the app did not answer at ${url} within ${ms / 1000} s`);
}

/** Clones the app, links dependencies, points .pen-multi.json at a free port. Returns the workspace. */
export async function makeWorkspace(app) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pen-real-${app.name}-`)));
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", app.repo, dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "eval@local"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "eval"]);
  for (const l of app.link ?? []) fs.symlinkSync(path.join(app.repo, l), path.join(dir, l));
  const port = await freePort();
  const conf = path.join(dir, path.dirname(app.pen), ".pen-multi.json");
  const c = JSON.parse(fs.readFileSync(conf, "utf8"));
  c.baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(conf, `${JSON.stringify(c, null, 2)}\n`);
  return { app, dir, pen: path.join(dir, app.pen), port, baseUrl: c.baseUrl, source: path.join(dir, app.source), routes: c.routes ?? {} };
}

/** Starts the app in the workspace; returns a stop function. */
export async function startApp(ws) {
  const cmd = ws.app.app.start.replaceAll("{port}", String(ws.port));
  const child = spawn(cmd, { cwd: path.join(ws.dir, ws.app.app.cwd ?? "."), shell: true, detached: true, stdio: "ignore" });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  };
  try {
    await waitFor(`${ws.baseUrl}/`);
  } catch (err) {
    stop();
    throw err;
  }
  return stop;
}

export const removeWorkspace = (ws) => fs.rmSync(ws.dir, { recursive: true, force: true });
