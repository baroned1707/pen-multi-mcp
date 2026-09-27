// Picks the project's design file(s) and starts their editors ahead of the first call.
import fs from "node:fs";
import path from "node:path";

/**
 * The files to pre-warm for a server running in `cwd`: `.pen-multi.json` "prewarm" paths if
 * listed, else the only *.pen directly in `cwd`. Several candidates without a list: none.
 */
export function prewarmCandidates(cwd) {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(cwd, ".pen-multi.json"), "utf8"));
    if (Array.isArray(conf.prewarm)) return conf.prewarm.filter((p) => typeof p === "string").map((p) => path.resolve(cwd, p));
  } catch {
    // no config, or not JSON: fall back to looking for a single file
  }
  let pens = [];
  try {
    pens = fs.readdirSync(cwd).filter((n) => n.endsWith(".pen"));
  } catch {
    return [];
  }
  return pens.length === 1 ? [path.join(cwd, pens[0])] : [];
}

/** Pre-warms each candidate not open in the desktop app. Never throws; failures go to stderr. */
export async function prewarm({ pool, app, normalize, cwd = process.cwd() }) {
  for (const candidate of prewarmCandidates(cwd)) {
    try {
      const file = normalize(candidate);
      if ((await app.available()) && (await app.openFiles({ fresh: true })).has(file)) {
        pool.prewarmResults.set(file, "skipped: open in the desktop app");
        continue;
      }
      await pool.prewarm(file);
    } catch (err) {
      process.stderr.write(`pen-multi: pre-warm of ${candidate} skipped: ${err.message}\n`);
    }
  }
}
