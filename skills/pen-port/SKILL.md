---
name: pen-port
description: Port a pen.dev design into the app's code screen by screen until every screen verifies as MATCH, without stopping halfway. Use when asked to implement, port, refactor or "make the UI match" a .pen design across several screens, states, widths or themes.
---

# pen-port: implement a design until it matches

Uses the pen-multi MCP tools (`mcp__pen-multi__*`). The queue lives in `design-verify/port-*.json`, so work survives context compaction and is shared by subagents.

## 1. Set up (once)

1. `overview` the .pen, and `lint` it: fix what lint can fix (`fix: ["names", "tokens"]`) and tell the user about the rest before porting a broken design.
2. Make sure the app runs (start its dev server, simulator or emulator yourself).
3. In `.pen-multi.json` next to the .pen, map screens to pages and states:
   ```json
   { "baseUrl": "http://localhost:5173",
     "routes": { "Home": "/", "Positions": "/positions" },
     "states": { "Home — empty": { "route": "/", "mocks": [{ "url": "**/api/today*", "json": [] }] } } }
   ```
   States (empty, error, loading, …) are shown with `mocks` (fixture responses, `delayMs` for loading), `steps` (click, fill, eval) or a dev flag you add to the app. Decide per project; prefer mocks.
4. `port({ action: "plan" })` (filter / widths / themes to narrow it). Fix the routes and states it reports as missing.

## 2. The loop (each agent)

Repeat until `port next` says nothing is left:

1. `port({ action: "next", claim: "<your name>" })` — gives the frame id, page, state setup and the last findings.
2. `inspect` it with the given `savePath`; re-read that file after compaction instead of re-inspecting.
3. Implement it in the existing code: the design is the source of truth; rebuild shells, navigation and components whose structure differs; mark elements with `data-pen="<address>"` (web) / `testID="pen:<address>"` (React Native). Reuse what inspect maps: a line `Name → Button (src/Button.tsx:4)` is that code component, and tokens show under their code names. When inspect lists a component as not mapped and the code has it, mark its definition with `data-pen="<component id>"` once; otherwise build it once as a component and reuse it.
4. `verify({ target: "<id>", source: { kind: "web" } })` (routes and states come from .pen-multi.json).
5. Fix the high findings first (missing, extra, order), then medium; each finding ends with `→ file:line` where the code is, and names the token to use. Verify again.
6. MATCH → `port({ action: "done", id })`. Out of attempts (to retry, re-run `plan` with a higher `maxAttempts`), or blocked by something only the user can decide → `port({ action: "block", id, reason })`, then continue with `next`.

Never report a screen as done without `port done` succeeding. Never stop while `next` hands out work.

## 3. Parallel (large ports)

When more than ~4 screens are left, start up to 3 subagents with the Agent tool, each with this prompt:

> Port screens of <file.pen> in <project>: follow the pen-port skill loop (section 2) with claim "<agent-N>" until `port next` says nothing is left for you. Do not edit files another agent is working on; if two screens share a component, the first one to need it changes it and the others re-verify.

Watch `port({ action: "status" })` between rounds. When the subagents have returned but `port next` still reports items in progress by others, a subagent stopped mid-item: wait until the lease time it prints, then call `port next` again to take the item over.

## 4. Finish

- `port status`: every item `match`, or `blocked` / `skipped` with reasons.
- `contact_sheet` with the verify reports of the ported screens, and a short summary: what matched, what is blocked and why, what the user must decide.
