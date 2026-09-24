# pen-multi speed: cached app state and background saves

Sub-project 1 of 4 for making agents work smoothly with pen.dev (next: fewer agent errors, design-quality tools, browser reliability).

## Problem

Transcripts from 2026-09-22 to 2026-09-24 (about 1,850 Pen tool calls) show `pen-multi` `execute` at a median of 4 s and p90 of 10 s, against 1 s for the official `pencil` server. A long session makes 600+ calls, so this adds 30+ minutes.

Measured cost of one app-routed write on a moderately loaded machine (load average ~64):

| Step | Cost |
|---|---|
| socket probe (`available()`) | ~0 ms |
| active document (`get_app_state` via the app's server) | ~300 ms |
| window list (`ps`) | ~100 ms |
| the `execute` itself | ~320 ms |
| save through CLI app mode | ~1,100–1,300 ms |

`openFiles()` asks for both the active document and the window list on every call, and every write waits for its save before responding. Only ~0.3 s of ~2.3 s is the actual work.

## Goals

- App-routed `execute`: median ≤ 0.6 s; headless `execute`: median ≤ 0.5 s, on a machine that is not overloaded.
- No loss of the routing guarantee: a write is never sent to a document other than its `filePath`.
- Every change still reaches disk without the agent doing anything, except that it must call `save` before reading the file from disk or committing it.

## Non-goals

- Replacing the app backend with CLI app mode (option C, rejected: large rewrite, loses `spawn_agents`).
- Changing the CLI or the app.

## Design

### 1. App state: fresh where it decides routing, cached where it is expensive

`AppBridge` gains a `snapshot` concept split into two parts with different freshness rules.

- **Window list** (`#windowFiles`, `ps`, ~100 ms): read on every call, never cached, because it decides where a write goes. Concurrent callers share one in-flight read (a promise reused until it settles), so parallel subagents trigger one `ps`, not one each.
- **Active document** (`activeFile()`, ~300 ms): cached for `PEN_MULTI_APP_STATE_TTL_MS` (default 2,000 ms), with concurrent callers sharing one in-flight request. The cache is dropped on any app call error, when the workbench is opened, and when routing reports a conflict.

Fresh active-document reads (bypassing the cache) are required in the two cases where a stale value could misroute a write:

1. A write with no `filePath` (it targets whatever is active now).
2. A write to a file that is not in the window list and matches only the cached active document (documents opened from the app's dashboard do not appear in `ps`). If the fresh read no longer names the file, it is routed headless.

Reads (`get_app_state`, read-only `browser` actions) may use the cached value.

`openFiles()` keeps its meaning (window list ∪ active document) but takes an option `{ fresh }` for the active part. `route()` passes `fresh: true` for the two cases above.

### 2. Background saves (`SaveScheduler`)

One scheduler per server process, used for both headless sessions and app documents.

- A successful write marks the file dirty and schedules a save; the tool responds immediately.
- The save runs after `PEN_MULTI_SAVE_DELAY_MS` (default 1,500 ms) of no further writes to that file. With one agent, the model's think time between calls (3–20 s) exceeds this, so each write is saved before the next call; bursts from parallel subagents on one file coalesce into one save.
- Saves of one file never overlap: a write arriving during a save marks the file dirty again and schedules another.
- Flush (save now and wait) on: `save`, `close_file`, `fork_version` (source file), headless↔app handover, eviction and idle close, and server shutdown.
- Headless saves go through the session's shell (`save()`), queued behind its calls as today. App saves use `AppBridge.save(file)` with the existing mtime check.
- Failure handling: the error is kept per file, returned as a `WARNING:` line on the next response for that file, shown in `list_sessions`, and written to stderr. A later successful save clears it.
- Response wording changes from `Saved to disk.` to `Saving to disk in the background; call save before reading or committing this file.`

Accepted risk: if the server process is killed, up to ~1.5 s of changes to a headless file can be lost. App documents stay in the app's memory.

### 3. Agent instructions

The server instructions gain one rule: call `save` before committing a `.pen` file or reading it from disk (git, `fork_version` from another agent, scripts). `save` waits for a running background save.

### 4. Observability

`list_sessions` adds `timings`: median and p90 in ms for `route`, `call` and `save`, over the last 200 calls of this server process, plus `pendingSaves` and `saveErrors` per file.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/app.js` `AppBridge` | window list (shared in-flight), cached active document with `fresh` override, invalidation | `ps`, app MCP server |
| `src/saver.js` `SaveScheduler` (new) | per-file dirty state, debounce, non-overlapping saves, flush, error memory | a save function per file |
| `src/timing.js` (new) | rolling samples, median/p90 | none |
| `src/index.js` | uses the above in `route()`, `appWrite`, headless `execute`, `save`, `close_file`, `fork_version`, `list_sessions`, shutdown | all of the above |
| `src/pool.js` | eviction/idle close/`closeAll` flush through the scheduler | `SaveScheduler` |

## Testing

All with the fake CLI and fake app (no real app touched):

1. A window closed after the active document was cached: the next write to that file goes headless, not to the app.
2. A write with no `filePath` after the active tab changed goes to the new active document within the TTL.
3. A dashboard-opened document (active only, not in the window list) that was closed: a write to it is not sent to the app.
4. Five writes to one file in quick succession cause exactly one save.
5. `save`, `close_file`, `fork_version` and shutdown each flush a pending save; `save` waits for an in-flight one.
6. A failed save shows a `WARNING:` on the next call for that file and in `list_sessions`, and clears after a successful save.
7. The active document is re-read after the TTL expires.
8. Concurrent calls share one `ps` read and one active-document request.

Plus a manual benchmark against the real app on a scratch document: median `execute` latency before and after.

## Rollout

Bump to 0.5.0. Running sessions pick it up with `/mcp` → pen-multi → Reconnect.
