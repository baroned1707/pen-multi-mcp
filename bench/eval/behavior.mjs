// How an agent worked, from its stream-json transcript: which pen-multi tools it called in what
// order, whether it edited the side the task said to edit, and what it said at the end.

/** Tool calls and the final result from `claude -p --output-format stream-json --verbose` output. */
export function parseStream(stdout) {
  const calls = [];
  let result = null;
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") for (const c of ev.message?.content ?? []) if (c.type === "tool_use") calls.push({ name: c.name.replace(/^mcp__pen-multi__/, ""), input: c.input ?? {} });
    if (ev.type === "result") result = ev;
  }
  return { calls, result };
}

const editsPage = (c, page) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && String(c.input.file_path ?? "").endsWith(page);

/**
 * Process scores for one run. `before`/`after`: { page, pen } contents (the .pen as a hash) to see
 * which side changed; `page` is the page file name.
 */
export function score(task, { calls, result }, { before, after, page }) {
  const firstEdit = calls.findIndex((c) => editsPage(c, page));
  const firstInspect = calls.findIndex((c) => c.name === "inspect");
  const verifies = calls.filter((c) => c.name === "verify");
  const codeChanged = before.page !== after.page;
  const designChanged = before.pen !== after.pen;
  const wantCode = task.direction === "design-to-code", wantDesign = task.direction === "code-to-design";
  return {
    inspectedBeforeEdit: firstEdit < 0 ? null : firstInspect >= 0 && firstInspect < firstEdit,
    markers: /data-pen=/.test(after.page),
    verifyRuns: verifies.length,
    usedCodeToDesign: verifies.some((c) => c.input.direction === "code-to-design"),
    wrongSide: (wantCode && designChanged) || (wantDesign && codeChanged) || false,
    bothOverwritten: task.direction === "both" ? codeChanged && designChanged : undefined,
    conflictReported: task.direction === "both" ? /conflict|both (sides|changed)|which (side|one|version)|should (i|we) (keep|follow)|\?/i.test(result?.result ?? "") : undefined,
    toolCalls: calls.length,
    finalText: String(result?.result ?? "").slice(0, 300),
  };
}
