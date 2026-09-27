import assert from "node:assert/strict";
import { test } from "node:test";
import { executeHints, mayWrite } from "../src/hints.js";

const OK_SILENT = "OK\n\nGlobal variables (e.g. root) carry over to subsequent calls!";

test("a read that prints nothing is flagged", () => {
  const [h] = executeHints({ input: "const r = Get(n => n.name); r.length", text: OK_SILENT });
  assert.match(h, /nothing was printed/i);
  assert.match(h, /Print\(/);
});

test("writes, screenshots and exports are not flagged for printing nothing", () => {
  for (const input of ['Update("a",{width:4})', 'TakeScreenshot(["a"])', 'Export(["a"],"png","./out")', 'x=Insert(document,{type:"frame"})']) {
    assert.deepEqual(executeHints({ input, text: OK_SILENT }), [], input);
  }
  assert.deepEqual(executeHints({ input: "Print(1)", text: "OK\n\n## Print output\n1" }), []);
});

test("console, await, non-array screenshots and interrupted runs get a concrete fix", () => {
  assert.match(executeHints({ input: "console.log(1)", error: "ReferenceError: 'console' is not defined" })[0], /Print\(/);
  assert.match(executeHints({ input: "const x = await Get('a')", error: "SyntaxError: expecting ';'" })[0], /synchronous/);
  assert.match(executeHints({ input: 'TakeScreenshot("a")', error: "nodeIds must be a non-empty array" })[0], /TakeScreenshot\(\["a"\]\)|array/);
  assert.match(executeHints({ input: "Get(n=>n)", error: "InternalError: interrupted" })[0], /split|inspect/);
});

test("an unrelated error gets no hint", () => {
  assert.deepEqual(executeHints({ input: "Get('zz')", error: "Node not found: zz" }), []);
});

test("writes are recognised however the function is reached", () => {
  for (const input of ["ids.forEach(Delete)", "const U = Update; U('a', { width: 4 })", "Update.call(null, 'a', {})", "SetVariables({ a: { type: 'number', value: 1 } })", "items.map(Insert.bind(null, 'p'))"]) {
    assert.equal(mayWrite(input), true, input);
  }
  assert.equal(mayWrite('Print(Get("a").name)'), false);
  assert.equal(mayWrite(undefined), true, "an edit retry's snippet is unknown");
  assert.deepEqual(executeHints({ input: "ids.forEach(Delete)", text: "OK" }), [], "no 'nothing printed' hint for a write");
});
