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

test("call log: causes from where the time went", async () => {
  const { cause } = await import("../src/calllog.js");
  assert.match(cause({ totalMs: 5000, marks: { call: 4800 }, mode: "app", appOthers: 0 }), /pen\.dev app itself was slow/);
  assert.match(cause({ totalMs: 5000, marks: { call: 4800 }, mode: "headless", appOthers: 0 }), /pen engine was slow/);
  assert.match(cause({ totalMs: 5000, marks: { route: 4000, call: 500 }, appOthers: 0 }), /where the file is open/);
  assert.match(cause({ totalMs: 5000, marks: {}, appOthers: 2 }), /2 other agent call/);
  assert.match(cause({ totalMs: 5000, marks: { call: 1000, route: 900 }, appOthers: 0 }), /no single step/);
});
