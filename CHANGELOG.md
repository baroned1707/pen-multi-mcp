# Changelog

## 1.7.0 — 2026-09-29

import_ui that looks drawn, not dumped (spec: `docs/superpowers/specs/2026-09-29-import-clean-design.md`). Measured on four trading-agent screens with `bench/eval/real/import-quality.mjs`:

| | before | 1.7.0 |
|---|---|---|
| round trip MATCH | 0/4 | 4/4 (3/4 with `components: true`) |
| icons as icon nodes / crops | 0 / 28 | 25–29 / 3–7 |
| layer names that are selectors | 41 | 10 |

- **Icons**: icon elements are compared as shapes with the icons the document uses (rendered once in a scratch file); a clear winner becomes an icon node, with the crop as its fallback.
- **Names** from the code: marker, React component (from the fiber), aria-label, id, a class that reads as a name; the selector is the last resort.
- **Grids and wrapping rows** become rows of auto layout (checked against the page like any auto layout).
- **`components: true`**: repeated structures become a component and instances overriding whatever differs.
- Fixes found on the real app:
  - a marker on a textless element (a tab link) no longer claims its label's text node;
  - letter spacing is captured and imported;
  - a generic marker ("Row") only makes an instance of the same-named component when its texts line up;
  - a marker shared by several elements pairs each design node with its nearest element.

## 1.6.1 — 2026-09-29

- Sync: findings are tagged with the side that edited them, and only with the side that merely moved them (a layout change elsewhere) when neither edited them; the frame's own background changing in the design no longer made every code edit a conflict.
- Real-app eval on 1.6.0 (trading-agent, n = 3): code → design 3/3, both 2/3 — the failure was the agent asking before renaming a tab label shared by every screen (a mutation no designer would make), not a pen-multi fault.

## 1.6.0 — 2026-09-29

- **Fonts**: a headless editor lays text out in a fallback font until its fonts load (~2 s after the first layout); verify, inspect, lint, import_ui and sync_status on a just-opened file measured the fallback, so a matching screen could report DIFFERS (trading-agent: 26 findings, then MATCH on the next call). Measuring tools now wait per editor and font family until text sizes settle (`PEN_MULTI_FONT_SETTLE_MS`, 0 turns it off). The web capture also loads every declared `@font-face` before measuring.
- **Code → design layout**: verify with direction `code-to-design` infers container edits from where the UI draws the matched children — gap, leading padding, order (`Move`), fixed sizes, absolute positions — each listing the findings it explains; uneven spacing or unmatched children get a reason instead. Gap and padding use a spacing token when the document puts one on those properties.
- **Sync**: both sides changing is a conflict only when they edited the same node on purpose; a node moved by a layout change on the other side no longer counts.
- **Real-app eval** (`npm run eval:real`, spec `docs/superpowers/specs/2026-09-29-real-app-eval-design.md`): seeded design mutations on frames that match on a real app's committed state (cloned to a temp folder, never touching the repository), with design-to-code, code-to-design and both tasks judged by verify and the side edited. trading-agent, n = 3 per kind, before the layout and conflict fixes: design → code 3/3, code → design 3/3, both 2/3 (the failure led to the conflict fix).

## 1.5.0 — 2026-09-29

- **Observability** (spec: `docs/superpowers/specs/2026-09-29-observability-design.md`): one event per tool call in `~/.pen-multi/events/` (measurements only — no arguments, texts or code; 30 days, 20 MB a day, `PEN_MULTI_EVENTS=0` to turn off), and `node bin/pen-multi.js report` for latency, errors, tokens, verify runs until MATCH, finding kinds, Next: followed, reminders and app waits. The eval attaches each run's MCP numbers.

## 1.4.0 — 2026-09-29

Design ↔ code sync, any-platform sources, doctor, and agents that use the tools well (spec: `docs/superpowers/specs/2026-09-29-sync-and-guidance-design.md`).

- **Sync records**: verify MATCH writes `design-sync/<frame>.json` (commit it); verify on DIFFERS says which side changed since, tags findings, carries changes across when the two sides changed different nodes (diverged), and asks the user when they changed the same ones; `sync_status` has per-frame states and next calls.
- **Any platform**: `source.kind` `file` and `command` with a published snapshot schema (`pen-multi://snapshot-schema`); commands run only when the user trusts them (`bin/pen-multi.js trust`, stored outside every repository).
- **doctor** checks a project's setup for both directions and says how to fix each item.
- **Guidance**: tool descriptions start with when to use them; the server instructions are a decision table; one `Next:` line from the frame's state ends every result; `Note:` reminders; MCP prompts `port-design`, `design-from-code`, `sync-check`.
- **Eval** scores how agents work (inspect before editing, markers, the side they edit, both changes kept) from their tool calls, with a both-changed task that starts from a recorded, committed MATCH.
- Measured with real agents (`bench/results/eval-2026-09-29.json`, n = 1 per cell, indicative only): every run reached MATCH on 1.3.0 and 1.4.0, and no run edited the wrong side. Code → design improved: both sides changed 411k → 210k tokens (1.4.0 used direction code-to-design and kept both edits), design update 422k → 257k. Design → code within the noise: port 209k → 261k, fix 114k → 162k (the same task measured 121k on 1.3.0 the day before).

## 1.3.0 — 2026-09-28

Context that lets agents port correctly, in both directions (spec: `docs/superpowers/specs/2026-09-28-agent-context-design.md`).

- **Measure first.** `src/metrics/context.js` measures what inspect gives agents (size, repeated facts, completeness of the facts needed per node — 100% is a test). `npm run bench:context` measures real files against any checkout (`PEN_MULTI_SERVER`); `npm run eval` runs real agents on three fixture tasks and is a dry run unless `--run`. Results in `bench/results/`.
- **inspect**: `detail` normal (default: own theme only, text defaults once, whole sections under the limit), full (the previous outline), summary. Code mapping: instances of components marked in code are one line naming the code component and `file:line`; tokens under their code names from `.pen-multi.json` `tokens.file`; what is not mapped is listed. A screen with several frames: one in full, the others as differences (themes that differ only through tokens are one line; raw values in a theme variant are flagged). Components get their API (slots, overrides in use, family, code). A labelled render the first time a node is inspected.
- **verify**: findings end with `→ file:line` from markers and name the design token and its code name; the verdict says what was not checked; the worst findings come as close-ups. `direction: "code-to-design"` proposes execute operations for findings with a clear cause (hide, never delete), and warns when the design was also edited.
- **import_ui**: number tokens for font sizes and radii; marked elements as component instances with text overrides; auto layout from flexbox and even column stacks, kept only where the engine reproduces the page within 2 px; one-line texts no longer wrap from font metric differences; reports raw values and repeated structures that look like components.
- **overview** flags screens that look like states the names do not mark, and cells with two frames of one theme, with how to name them.
- Markers are searched only inside the agent's git repository (tracked and untracked files, `.gitignore` respected; never a home folder), with file contents cached by mtime; when a marker is in several files, the file holding most of the screen's markers wins. Number tokens are used only for the property the document already puts them on (a spacing token of 16 is never a font size), and `1rem` never equals `1`. A container whose contents the code still shows is never proposed for hiding. A partial name match stays ambiguous instead of becoming variants.
- Renders and close-ups are sent at the design's own size (a 390×844 render is ~430 image tokens instead of ~1,500).
- Real agents (`npm run eval`, claude -p, same fixture design and judge for both sides; `bench/results/eval-*.json`): every run reached MATCH on both v1.2.0 and 1.3.0. Fix task 229k → 121k tokens and design update 323k → 256k (n = 1 each). Port: v1.2.0 195k on average (n = 4), 1.3.0 213k (n = 2, renders at design size) — the same within the spread; 1.3.0 had been at 285k while renders were sent at 2x. Small n: indicative only.
- Measured (inspect, same 8 screens per file, text tokens): near-me 3.9k → 3.6k (−8%), driversafe 2.8k → 2.6k (−10%) per screen, now including the code mapping section. A screen drawn 20 times (S1 of near-me: widths × themes × states) took 20 inspect calls (~78k tokens); it is now one call of ~3.7k.

## 1.2.0 — 2026-09-28

- `port`: a durable queue for porting a design screen by screen until MATCH (plan / next with claims for parallel agents / done only on a fresh MATCH / skip / block / status); verify records each run on it.
- `verify` / `capture` web sources take `mocks` (fixture answers for matching requests, with status, delay and files) to show a screen's state without a backend; `.pen-multi.json` `states` declare route, steps, mocks and deep link per screen state.
- `skills/pen-port`: a Claude Code skill that drives the loop, with subagents for large ports.
- Machine-wide locks also exclude callers inside one process, so parallel `port next` calls from one server never get the same item. A filtered `plan` keeps the rest of the queue and its `maxAttempts`; raising `maxAttempts` reopens items blocked for running out of attempts. A state frame never borrows its screen's states entry. The first matching mock wins; mocks answer credentialed CORS requests and preflights; verify reports are named per frame id.

## 1.1.0 — 2026-09-28

- Slow-call diagnostics: calls over 3 s are logged machine-wide (`~/.pen-multi/slow.jsonl`) with their time per step and whether other agents were using the pen.dev app; `list_sessions` shows them with a likely cause; a call that waited behind other agents' app calls says so. Measured on the app: screenshots and exports take 0.35–0.8 s whether Pen is in front, behind another app or hidden, so earlier 17–60 s screenshots came from something else — this log is there to catch it next time.

## 1.0.3 — 2026-09-28

From watching the trading-agent session use it:
- execute retries accept `edits` written as `{ old, new }` (agents wrote it that way three times, each costing a failed call).
- ambiguous screen names list each candidate's width and theme.
- verify: a missing wrapper whose main contents are present is medium and says the container is what differs.
- tokens compare: code-only tokens are listed on one line.

## 1.0.2 — 2026-09-28

- A server whose host dies without closing stdin (crash, kill -9) notices it is re-parented and shuts down within ~2 s, releasing its file locks; shutdown never takes longer than 10 s (`PEN_MULTI_SHUTDOWN_TIMEOUT_MS`). Found an orphaned server that had held on for 11 hours.

## 1.0.1 — 2026-09-28

Checked on a real iOS 27 simulator (iPhone 18 Pro):
- native iOS: labels are read from accessibility text (leaves only); maestro's point boxes are no longer divided by the screen scale; the booted simulator is resolved for maestro ("Multiple devices connected"); maestro is found in `~/.maestro/bin` and given a JDK when the host's PATH has none (macOS's `/usr/bin/java` stub does not count); tool errors skip JVM warnings.
- pen-probe on iOS (Expo SDK 57): boxes, text, colors, fonts and icons verified against the screenshot.

## 1.0.0 — 2026-09-28

Production release: all four parts of the design ↔ code roadmap.

- **Verify design ↔ code** (0.8): `verify`, `capture`, `contact_sheet` for web (headless Chromium), React Native / Expo (`probe/react-native/PenProbe.js`), native Android / iOS (uiautomator / maestro) and screenshots. Findings as text (missing, extra, order, layout, color, typography, pixels), markers, anchors for other device widths, device chrome skipped, modern CSS colors (oklch, hsl, color-mix), shadow DOM, iframes (cross-origin through the browser), scroll-revealed content.
- **Design quality** (0.9): `lint` with safe fixes (names, tokens) and rules for contrast (measured on the render over images and gradients), covered text, touch targets, raw colors, off-scale values, hidden/clipped leftovers, alignment, spacing, variants; `tokens` to CSS / Tailwind / W3C JSON / React Native with a diff against code.
- **Code → design** (0.9): `import_ui` rebuilds a running screen as a frame (round trip verifies as MATCH), `sync_status`, routes in `.pen-multi.json`.
- **Speed** (0.7): pre-warm of the project's design file, one-call `overview`, `npm run bench`.

## 0.6.0

Design context: `overview`, `inspect`, port-mode guidance, execute hints.

## 0.5.0 and earlier

Background, multi-project, multi-agent editing: headless sessions per file, app routing without stealing focus, locks, limits, background saves, workbench browser, full parity with the official server.
