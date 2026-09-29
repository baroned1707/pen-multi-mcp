// The observability report: how pen-multi performed, from the events log (src/events.js).
const pct = (list, p) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = (list) => pct(list, 50);

/** Aggregates events into the report's numbers (also the --json form). */
export function summarize(events) {
  const byTool = {};
  for (const e of events) {
    const t = (byTool[e.tool] ??= { calls: 0, errors: 0, ms: [], text: 0, image: 0, steps: {}, errorsSeen: {} });
    t.calls++;
    if (!e.ok) {
      t.errors++;
      t.errorsSeen[e.error] = (t.errorsSeen[e.error] ?? 0) + 1;
    }
    t.ms.push(e.ms);
    t.text += e.tokens?.text ?? 0;
    t.image += e.tokens?.image ?? 0;
    for (const [k, v] of Object.entries(e.marks ?? {})) t.steps[k] = (t.steps[k] ?? 0) + v;
  }
  const tools = Object.entries(byTool)
    .map(([tool, t]) => {
      const total = t.ms.reduce((a, b) => a + b, 0);
      const [step, stepMs] = Object.entries(t.steps).sort((a, b) => b[1] - a[1])[0] ?? [];
      return { tool, calls: t.calls, errors: t.errors, p50: median(t.ms), p95: pct(t.ms, 95), textTokens: Math.round(t.text / t.calls), imageTokens: Math.round(t.image / t.calls), mainStep: step && total ? { step, share: Math.round((stepMs / total) * 100) } : null, topError: Object.entries(t.errorsSeen).sort((a, b) => b[1] - a[1])[0]?.[0] };
    })
    .sort((a, b) => b.calls - a.calls);

  // Verify: runs per frame until its first MATCH, frames never matched, finding kinds.
  const frames = new Map();
  const kinds = {}, directions = {}, syncStates = {};
  for (const e of events.filter((x) => x.tool === "verify" && x.verify)) {
    const key = `${e.file}|${e.verify.frame}`;
    const f = frames.get(key) ?? { runs: 0, matchedAfter: null };
    f.runs++;
    if (e.verify.verdict === "match" && f.matchedAfter === null) f.matchedAfter = f.runs;
    frames.set(key, f);
    for (const k of e.verify.kinds ?? []) kinds[k] = (kinds[k] ?? 0) + 1;
    directions[e.verify.direction ?? "design-to-code"] = (directions[e.verify.direction ?? "design-to-code"] ?? 0) + 1;
    if (e.verify.sync) syncStates[e.verify.sync] = (syncStates[e.verify.sync] ?? 0) + 1;
  }
  const matched = [...frames.values()].filter((f) => f.matchedAfter !== null).map((f) => f.matchedAfter);
  const judged = events.filter((e) => e.followedNext !== undefined);
  const waited = events.filter((e) => e.appOthers);
  return {
    from: events[0]?.at ?? null,
    to: events.at(-1)?.at ?? null,
    calls: events.length,
    projects: [...new Set(events.map((e) => e.project.split("#")[0]))],
    tools,
    verify: { frames: frames.size, matched: matched.length, runsToMatch: { median: median(matched), max: matched.length ? Math.max(...matched) : null }, neverMatched: frames.size - matched.length, findingKinds: Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 8), directions, syncStates },
    next: { judged: judged.length, followed: judged.filter((e) => e.followedNext).length },
    notes: events.reduce((s, e) => s + (e.notes ?? 0), 0),
    appWait: { calls: waited.length, ms: waited.reduce((s, e) => s + e.ms, 0) },
  };
}

const sec = (ms) => (ms === null ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The report as text for a person. */
export function renderSummary(s, { days, capped = [] } = {}) {
  if (!s.calls) return [`No pen-multi calls recorded in the last ${days} day(s). Events are written to ~/.pen-multi/events/ unless PEN_MULTI_EVENTS=0.`];
  const L = [`# pen-multi: ${s.calls} calls, ${s.from.slice(0, 16).replace("T", " ")} → ${s.to.slice(0, 16).replace("T", " ")} (${s.projects.length} project${s.projects.length > 1 ? "s" : ""}: ${s.projects.join(", ")})`, ""];
  if (capped.length) L.push(`⚠️ Days that hit the 20 MB cap (later calls not recorded): ${capped.join(", ")}`, "");
  L.push("## Tools", "tool | calls | errors | p50 | p95 | most time in | tokens (text + images) | most frequent error");
  for (const t of s.tools) L.push(`${t.tool} | ${t.calls} | ${t.errors ? `${t.errors} (${Math.round((t.errors / t.calls) * 100)}%)` : 0} | ${sec(t.p50)} | ${sec(t.p95)} | ${t.mainStep ? `${t.mainStep.step} ${t.mainStep.share}%` : "–"} | ${t.textTokens}${t.imageTokens ? ` + ${t.imageTokens}` : ""} | ${t.topError ?? "–"}`);
  const v = s.verify;
  if (v.frames) {
    L.push("", "## Verify", `- ${v.frames} frames verified; ${v.matched} reached MATCH after ${v.runsToMatch.median} run(s) (median, max ${v.runsToMatch.max}); ${v.neverMatched} not (yet).`, `- Most frequent findings (medium and high): ${v.findingKinds.map(([k, n]) => `${k} ${n}`).join(", ") || "none"}.`, `- Direction: ${Object.entries(v.directions).map(([k, n]) => `${k} ${n}`).join(", ")}.${Object.keys(v.syncStates).length ? ` Sync: ${Object.entries(v.syncStates).map(([k, n]) => `${k} ${n}`).join(", ")}.` : ""}`);
  }
  L.push("", "## Agents", `- Next: followed ${s.next.judged ? `${Math.round((s.next.followed / s.next.judged) * 100)}% (${s.next.followed}/${s.next.judged} calls after a suggestion)` : "– (no suggestion followed by another call yet)"}.`, `- Reminders (Note:) shown: ${s.notes}.`, `- Calls that waited for other agents on the pen.dev app: ${s.appWait.calls} (${sec(s.appWait.ms)} in total).`);
  return L;
}
