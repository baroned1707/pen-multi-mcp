/**
 * Saves files in the background. A write marks its file dirty and returns at once; the save
 * runs once the file has had no writes for `delayMs`. Saves of one file never overlap: a write
 * during a save marks the file dirty again. flush() saves now and waits.
 */
export class SaveScheduler {
  constructor({ delayMs = 1500, onError = () => {} } = {}) {
    this.delayMs = delayMs;
    this.onError = onError;
    this.files = new Map(); // file -> { save, dirty, timer, running, error }
  }

  #entry(file) {
    let e = this.files.get(file);
    if (!e) {
      e = { save: null, dirty: false, timer: null, running: null, error: null };
      this.files.set(file, e);
    }
    return e;
  }

  markDirty(file, save) {
    const e = this.#entry(file);
    e.save = save;
    e.dirty = true;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this.#run(file).catch(() => {}), this.delayMs);
    e.timer.unref?.();
  }

  async #run(file) {
    const e = this.#entry(file);
    clearTimeout(e.timer);
    e.timer = null;
    // Another run (timer or flush) may have started meanwhile: wait for every save in flight.
    while (e.running) await e.running.catch(() => {});
    if (!e.dirty) return;
    e.dirty = false;
    e.running = e.save().then(
      () => {
        e.error = null;
      },
      (err) => {
        e.error = err.message;
        this.onError(file, err);
        throw err;
      },
    );
    try {
      await e.running;
    } finally {
      e.running = null;
    }
  }

  /** Saves `file` now if it has unsaved writes, and waits for any save in progress. */
  async flush(file) {
    if (!this.files.has(file)) return;
    return this.#run(file);
  }

  async flushAll() {
    await Promise.allSettled([...this.files.keys()].map((f) => this.flush(f)));
  }

  error(file) {
    return this.files.get(file)?.error ?? null;
  }

  pending() {
    return [...this.files].filter(([, e]) => e.dirty || e.running).map(([f]) => f);
  }

  errors() {
    return Object.fromEntries([...this.files].filter(([, e]) => e.error).map(([f, e]) => [f, e.error]));
  }
}
