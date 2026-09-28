// The port queue: one item per design frame to implement, with who is on it, how many verify runs
// it took, and whether it matched. Pure functions over a plain object, persisted by the port tool.

export const LEASE_MS = 30 * 60_000;
export const STATUSES = ["todo", "in-progress", "match", "blocked", "skipped"];

/**
 * Adds or refreshes `cells` in the queue, keeping every known item's progress. Items outside
 * `cells` are kept (a filtered plan must not forget the rest) unless their frame no longer exists
 * (`frameIds`). maxAttempts defaults to the queue's; raising it reopens items blocked for running
 * out of attempts.
 */
export function planQueue(existing, cells, { maxAttempts, frameIds, now = Date.now() } = {}) {
  const max = maxAttempts ?? existing?.maxAttempts ?? 5;
  const byId = new Map((existing?.items ?? []).filter((i) => !frameIds || frameIds.has(i.id)).map((i) => [i.id, i]));
  for (const c of cells) {
    const prev = byId.get(c.id);
    const fields = { name: c.name, screen: c.screen, state: c.state, width: c.width, theme: c.theme, route: c.route, stateConfig: c.stateConfig };
    byId.set(c.id, prev ? { ...prev, ...fields } : { id: c.id, ...fields, status: "todo", attempts: 0 });
  }
  const items = [...byId.values()].map((i) => (i.status === "blocked" && i.autoBlocked && (i.attempts ?? 0) < max ? { ...i, status: "todo", autoBlocked: undefined, reason: undefined } : i));
  return { version: 1, createdAt: existing?.createdAt ?? new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), maxAttempts: max, items };
}

const leaseAlive = (item, now) => item.status === "in-progress" && item.leaseUntil && Date.parse(item.leaseUntil) > now;

/**
 * The next item for `claim`: its own in-progress item first (resume), else the first todo or an
 * in-progress item whose lease expired. Items out of attempts become blocked. Returns
 * { queue, item } (item null when nothing is left for this claim).
 */
export function nextItem(queue, claim, { now = Date.now() } = {}) {
  const q = structuredClone(queue);
  for (const i of q.items) {
    if ((i.status === "todo" || i.status === "in-progress") && i.attempts >= q.maxAttempts && i.lastVerdict !== "match") {
      i.status = "blocked";
      i.autoBlocked = true;
      i.reason = `${i.attempts} verify runs without MATCH; needs a decision (raise maxAttempts with plan to retry)`;
      delete i.claim;
      delete i.leaseUntil;
    }
  }
  const lease = new Date(now + LEASE_MS).toISOString();
  let item = q.items.find((i) => i.status === "in-progress" && i.claim === claim);
  item ??= q.items.find((i) => i.status === "todo" || (i.status === "in-progress" && !leaseAlive(i, now)));
  if (item) Object.assign(item, { status: "in-progress", claim, leaseUntil: lease, startedAt: item.startedAt ?? new Date(now).toISOString() });
  q.updatedAt = new Date(now).toISOString();
  return { queue: q, item: item ?? null };
}

/** Records a verify run on the frame's item (when it is in the queue). */
export function recordVerify(queue, id, { verdict, report, high, medium }, { now = Date.now() } = {}) {
  const q = structuredClone(queue);
  const item = q.items.find((i) => i.id === id);
  if (!item) return { queue, item: null };
  item.attempts = (item.attempts ?? 0) + 1;
  item.lastVerdict = verdict;
  item.lastReport = report;
  item.lastCounts = { high, medium };
  item.lastVerifiedAt = new Date(now).toISOString();
  if (item.status === "in-progress") item.leaseUntil = new Date(now + LEASE_MS).toISOString(); // still working on it
  q.updatedAt = new Date(now).toISOString();
  return { queue: q, item };
}

/** Sets an item's final status (match / skipped / blocked) with an optional reason. */
export function settle(queue, id, status, reason, { now = Date.now() } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
  const q = structuredClone(queue);
  const item = q.items.find((i) => i.id === id);
  if (!item) throw new Error(`${id} is not in the port queue; run port plan first (or check the id).`);
  item.status = status;
  if (reason) item.reason = reason;
  else delete item.reason;
  delete item.claim;
  delete item.leaseUntil;
  item.settledAt = new Date(now).toISOString();
  q.updatedAt = item.settledAt;
  return { queue: q, item };
}

export function counts(queue) {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const i of queue.items) out[i.status] = (out[i.status] ?? 0) + 1;
  return out;
}
