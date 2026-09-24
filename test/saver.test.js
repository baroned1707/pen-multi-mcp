import assert from "node:assert/strict";
import { test } from "node:test";
import { SaveScheduler } from "../src/saver.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a burst of writes to one file causes one save after the delay", async () => {
  let saves = 0;
  const s = new SaveScheduler({ delayMs: 50 });
  for (let i = 0; i < 5; i++) s.markDirty("a.pen", async () => saves++);
  assert.equal(saves, 0, "nothing saved before responding");
  await sleep(120);
  assert.equal(saves, 1);
  assert.deepEqual(s.pending(), []);
});

test("flush saves now and waits; a flush during a save waits for it", async () => {
  let saves = 0;
  const s = new SaveScheduler({ delayMs: 10_000 });
  s.markDirty("a.pen", async () => {
    await sleep(50);
    saves++;
  });
  await s.flush("a.pen");
  assert.equal(saves, 1);
  await s.flush("a.pen"); // nothing pending: returns at once
  assert.equal(saves, 1);
});

test("saves of one file never overlap; a write during a save schedules another", async () => {
  let running = 0, maxRunning = 0, saves = 0;
  const save = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await sleep(40);
    running--;
    saves++;
  };
  const s = new SaveScheduler({ delayMs: 10 });
  s.markDirty("a.pen", save);
  await sleep(20); // first save is running
  s.markDirty("a.pen", save);
  await s.flush("a.pen");
  assert.equal(maxRunning, 1);
  assert.equal(saves, 2);
});

test("a failed save is remembered until a later save succeeds", async () => {
  const s = new SaveScheduler({ delayMs: 10 });
  s.markDirty("a.pen", async () => {
    throw new Error("disk full");
  });
  await s.flush("a.pen").catch(() => {});
  assert.match(s.error("a.pen"), /disk full/);
  s.markDirty("a.pen", async () => {});
  await s.flush("a.pen");
  assert.equal(s.error("a.pen"), null);
});

test("flushAll saves every pending file", async () => {
  const saved = [];
  const s = new SaveScheduler({ delayMs: 10_000 });
  for (const f of ["a.pen", "b.pen"]) s.markDirty(f, async () => saved.push(f));
  await s.flushAll();
  assert.deepEqual(saved.sort(), ["a.pen", "b.pen"]);
});
