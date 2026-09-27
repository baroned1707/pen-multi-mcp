// Hints appended to execute responses for failures agents miss. The snippet is never rewritten:
// a failed read that returns plain "OK" looks like success, and agents have ported whole screens
// from memory after one (trading-agent, 2026-09-26).

// Any mention counts, not just a call: `ids.forEach(Delete)` and `const U = Update; U(...)` write too.
// Treating a read as a write costs one save; treating a write as a read loses the change.
const WRITES = /\b(Insert|Update|Delete|Replace|Move|Copy|SetVariables|Generate)\b/;

/** Whether a snippet may change the document. Unknown snippets (edit retries) count as writes. */
export const mayWrite = (input) => !input || WRITES.test(input);

const DOES_SOMETHING = /\b(Insert|Update|Delete|Replace|Move|Copy|SetVariables|Generate|Export|TakeScreenshot|Print)\b/;

export function executeHints({ input = "", text = "", error = null }) {
  const hints = [];
  if (error) {
    if (/'console' is not defined|console is not defined/.test(error)) {
      hints.push("`console` does not exist in the sandbox: use Print(...) to see values.");
    } else if (/SyntaxError/.test(error) && /\bawait\b/.test(input)) {
      hints.push("Snippets run synchronously: remove `await` (Get, Insert, etc. return values directly).");
    } else if (/non-empty array/.test(error) && /\b(TakeScreenshot|Export)\s*\(/.test(input)) {
      hints.push('Pass an array of node ids, e.g. TakeScreenshot(["id"]) or Export(["id"], "png", "./out").');
    } else if (/\binterrupted\b/.test(error)) {
      hints.push("The snippet ran too long and was stopped: split it into smaller calls, or read the design with the inspect tool.");
    }
    return hints;
  }
  if (!DOES_SOMETHING.test(input) && !/## Print output|## Created nodes|Screenshots taken/.test(text)) {
    hints.push("Nothing was printed: the value of the last expression is not returned. Wrap what you want to see in Print(...).");
  }
  return hints;
}
