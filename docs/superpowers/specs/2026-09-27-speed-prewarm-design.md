# pen-multi: pre-warm, fewer engine calls, bench

Sub-project 1 of 4 after 0.6.0 (next: verify design ↔ code, design-file quality, code → design).

## Measurements (headless, real project files, 2026-09-27)

| Cost | Value | Reducible |
|---|---|---|
| CLI start (first call on a file) | ~1.5 s, 2–3 s under load | yes: pre-warm |
| One `execute` inside the CLI | ~330 ms, even for `Print(1)` | no (CLI internals) |
| pen-multi overhead per call | ~40 ms | negligible |
| `save` | ~50–200 ms | — |
| `overview` cold | 2 engine calls (roots, stats) | yes: one call |
| Idle editor memory (5.8 MB file) | ~400 MB RSS, ~590 MB after a full read | bounds pre-warm |

## 1. Pre-warm

A pen-multi server starts an editor for the project's design file before the agent asks for it, without taking the file lock.

**Candidate.** `.pen-multi.json` `"prewarm": ["path.pen", ...]` (relative to the server's working directory) if present; otherwise the only `*.pen` directly in the working directory. None or several: nothing is pre-warmed. Only files that exist.

**When.** 2 s after the server starts, once.

**Skipped when** `PEN_MULTI_PREWARM=0`; the file is open in the desktop app; the file lock is held by a live process; another process already pre-warmed it; this server or the machine has no free editor slot (pre-warm never evicts anything). Any failure is silent (stderr only).

**Marker.** A pre-warmed editor holds `FileLock("warm:<file>")` in the lock directory. Exclusive creation dedupes pre-warm across processes, and `FileLock.live()` counts it toward `globalMaxSessions`. It does not block anyone: the real lock key is the file itself.

**Adoption** (first `pool.use` of that file):
- `inPath` given and different from the file → close the warm editor, open normally.
- Warm editor exited, or the file's `mtimeMs`/`size` differ from when it was loaded → close it, open normally.
- Otherwise: fail fast if the real lock is held elsewhere (close the warm editor), release the marker, make room under both limits, acquire the real lock, and use the warm shell as the session's shell.

**Expiry.** Closed after `PEN_MULTI_PREWARM_MINUTES` (default 3) without adoption. `#makeRoom` closes a warm editor before evicting any idle session. `closeAll` closes it.

**Visibility.** `list_sessions` lists it with `state: "warm"`; real sessions get `state: "open"`.

## 2. One engine call for `overview`

`readOverview` first runs one snippet that prints `ROOTS` and `STATS` for every root frame/group (each part in its own block so `const` names do not clash; ids computed inside the snippet). If that call is interrupted, it falls back to the current path: roots, then stats in batches halved on interruption.

## 3. `npm run bench`

`bench/bench.mjs <file.pen>...` copies each file (and sibling images) to a temp dir and reports per file: first open, read, write, save, overview cold/cached, inspect; then all files in parallel from separate server processes; the same-file conflict latency; and that every write is on disk after the servers exit. Never touches the originals. Not part of `npm test`.

## Testing

Fake CLI (pool tests): adoption uses the warm process (no second spawn); stale file → reopened; lock held elsewhere → warm closed, error unchanged; marker blocks a second process from pre-warming; warm counted toward the global limit and closed first by `#makeRoom`; expiry; `PEN_MULTI_PREWARM=0`; candidate selection (config list, single file, several → none). Read tests: combined overview is one call; interruption falls back to batches.

## Out of scope

Automated app-mode benchmarks (would have to open a document in the app, which shows a window). Measured by hand while the user has Pen open.
