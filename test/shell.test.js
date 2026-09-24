import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCall, extractError } from "../src/shell.js";
import { toContent } from "../src/format.js";

test("encodeCall keeps a multi-line snippet on one shell line", () => {
  const line = encodeCall("execute", { input: "a\nb\u2028c" });
  assert.ok(!/[\n\u2028]/.test(line));
  assert.equal(line, 'execute({"input":"a\\nb\\u2028c"})');
  assert.equal(encodeCall("get_app_state"), "get_app_state()");
});

test("extractError only reports the shell's final Error message", () => {
  const stderr = "[ERROR] [batch] SyntaxError: expecting ','\nError: ### Failure\n- `editId`: \"Ab1\"\n";
  assert.equal(extractError(stderr), '### Failure\n- `editId`: "Ab1"');
  assert.equal(extractError("(node:1) Warning: something deprecated\n[WARN] slow\n"), null);
  assert.equal(extractError(""), null);
});

test("toContent lifts screenshot JSON into image content", () => {
  const out = toContent('OK\n\n[\n  {\n    "nodeId": "X1",\n    "image": "iVBORw0",\n    "mimeType": "image/png"\n  }\n]\n');
  assert.equal(out[0].type, "text");
  assert.match(out[0].text, /1 screenshot\(s\) attached: X1/);
  assert.deepEqual(out[1], { type: "image", data: "iVBORw0", mimeType: "image/png" });
});
