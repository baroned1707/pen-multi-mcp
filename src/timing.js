import { mark } from "./calllog.js";

/** Rolling latency samples per step, for list_sessions (and the current call's breakdown). */
export class Timings {
  constructor(limit = 200) {
    this.limit = limit;
    this.samples = new Map();
  }

  record(step, ms) {
    const list = this.samples.get(step) ?? [];
    list.push(ms);
    if (list.length > this.limit) list.shift();
    this.samples.set(step, list);
  }

  async time(step, fn) {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      const ms = Math.round(performance.now() - started);
      this.record(step, ms);
      mark(step, ms);
    }
  }

  summary() {
    const out = {};
    for (const [step, list] of this.samples) {
      const sorted = [...list].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      out[step] = { n: sorted.length, medianMs: at(0.5), p90Ms: at(0.9) };
    }
    return out;
  }
}
