import assert from "node:assert/strict";
import { test } from "node:test";
import { Timings } from "../src/timing.js";

test("summary reports median and p90 per step over the most recent samples", () => {
  const t = new Timings(5);
  for (const ms of [100, 1, 2, 3, 4, 5]) t.record("call", ms); // 100 falls out of the window
  assert.deepEqual(t.summary(), { call: { n: 5, medianMs: 3, p90Ms: 5 } });
});

test("time() records how long an async function took and returns its result", async () => {
  const t = new Timings();
  const out = await t.time("route", async () => {
    await new Promise((r) => setTimeout(r, 20));
    return "x";
  });
  assert.equal(out, "x");
  assert.ok(t.summary().route.medianMs >= 15);
});
