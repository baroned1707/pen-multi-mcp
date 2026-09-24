/** Rolling latency samples per step, for list_sessions. */
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
      this.record(step, Math.round(performance.now() - started));
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
