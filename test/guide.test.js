// One source for every "Next:" line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStep } from "../src/guide.js";

test("nextStep: every state has one clear next call", () => {
  const states = ["inspected", "never", "differs", "match", "imported", "design-changed", "code-changed", "both-changed", "diverged", "in-sync"];
  for (const state of states) assert.match(nextStep({ state, id: "abc" }), /^Next: /, state);
  assert.match(nextStep({ state: "differs", id: "a", direction: "code-to-design" }), /apply the proposed edits/);
  assert.match(nextStep({ state: "code-changed", id: "a" }), /verify\(\{ target: "a", direction: "code-to-design" \}\)/);
  assert.match(nextStep({ state: "never", id: "a" }), /verify\(\{ target: "a", source: <the running app> \}\)/);
  assert.match(nextStep({ state: "both-changed", id: "a" }), /ask the user which side wins/);
  assert.match(nextStep({ state: "match", id: "a", others: ["b", "c"] }), /other frames too \(b, c\)/);
});
