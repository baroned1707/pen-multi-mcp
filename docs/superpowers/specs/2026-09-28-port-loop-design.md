# pen-multi: autonomous port loop (port tool, mocks, states, pen-port skill)

## Problem

Porting a design is many screens × states × widths × themes. Agents stop after a few, lose track after context compaction, mark screens done that still differ, and cannot put the app into a screen's state (empty, error, loading) to verify it.

## 1. Mocks and states

- `source` (web) takes `mocks: [{ url, method?, status?, json? | body? | file?, headers?, delayMs? }]`. `url` is a Playwright glob or `/regex/flags`. Matching requests are answered in the headless browser; others go through.
- `.pen-multi.json` next to the .pen may declare `states: { "<frame name | 'Screen — state' | screen code>": { route?, steps?, mocks?, deepLink? } }`. `verify` (and `port next`) apply the entry for the frame: its route when no url is given, its steps before the call's steps, its mocks with the call's mocks (call's win on the same url), its deepLink for probe/native when none is given.

## 2. `port` tool

State per .pen in `design-verify/port-<name>-<hash>.json`, read-modify-written under a machine-wide lock.

- `plan { filter?, widths?, themes?, maxAttempts (5) }`: one item per matrix cell (frame): id, name, screen, state, width, theme, route/state config found, status `todo`. Re-planning keeps existing items' progress.
- `next { claim? }`: the claimer's own in-progress item first (resume after compaction), else the first `todo` or expired lease (30 min). Marks it `in-progress` for `claim` (default `main`; parallel subagents pass their own name, since subagents share one server process). Items at `maxAttempts` verify runs without MATCH become `blocked`. Returns the frame id, url (or how to add a route), state config, the last verify's top findings, attempts, a spec path for `inspect savePath`, and the loop.
- `done { id }`: only if the latest verify report of that frame for this .pen is MATCH and the .pen has not changed since (hashed after pending saves). Otherwise refused with the findings count.
- `skip { id, reason }`, `block { id, reason }`, `status`.
- `verify` records each run on the item (attempts, verdict, report path).

## 3. Loop (server instructions)

plan → next → inspect (savePath) → implement with markers → verify (states/mocks as needed) → fix until MATCH → done → next. Stop only when status has no todo/in-progress left, or everything left is blocked and needs the user. Never call done without MATCH; after maxAttempts, block with the reason.

## 4. `pen-port` skill (Claude Code)

`skills/pen-port/SKILL.md` in the repo (installed to `~/.claude/skills/pen-port`): the orchestrator runs `port plan`, starts up to N (default 3) subagents that each loop `port next { claim: "<name>" }` until nothing is left, watches `port status`, and ends with a `contact_sheet` of every verified screen and the blocked list.

## Testing

Queue logic (claims, leases, resume, blocking, re-plan) as unit tests; mocks served to a page; end to end with the real CLI and Chromium: plan → next → verify DIFFERS → fix the page → verify MATCH → done; done refused before MATCH and after the design changed; parallel claims get different screens; a state from `.pen-multi.json` (route + mocks) used by verify.
