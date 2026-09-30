# pen-multi-mcp

An MCP server for pen.dev `.pen` files that covers **every tool of the official pen.dev MCP server**, works **with or without the desktop app**, and is built for **many agents working on many projects at the same time**.

The official `pencil` MCP server forwards every call to the single running desktop app. That means:

- the app must be open, with the target document open in a window;
- a `filePath` that is not open in the app silently falls back to the app's *active* document, so edits can land in the wrong project.

`pen-multi-mcp` has two backends and picks one per call:

| Target | Backend |
|---|---|
| A file **open in the running pen.dev app** (any window), or no `filePath` | The app, through its own MCP server binary, run as a child. Edits are live on the user's canvas, then saved to disk. |
| Any other `.pen` file | Its own headless [`@pen.dev/cli`](https://www.npmjs.com/package/@pen.dev/cli) `pen interactive` process. No app needed. |

Before every app call, pen-multi checks that the app really has the file open (its active window, or a window whose renderer process was launched with that file), so a file is never silently sent to another document. The CLI and the app's server are used as-is: not modified, patched or bundled.

**pen-multi never opens, focuses or raises your windows.** Opening a document in Pen puts its window in front of every app except the one you are in, even with `open -g`, so pen-multi does not open your files in the app:

- `browser` runs in a **workbench**: one scratch document (`~/.pen-multi/workbench/workbench.pen`) that pen-multi opens once per Pen session and moves off screen (macOS leaves a sliver in the bottom-left corner). That first open shows its window briefly; afterwards, browser calls leave the window order unchanged.
- `import-to-canvas` / `screenshot-to-canvas` run in the workbench, then the new layers are rebuilt in `filePath` (headless or open in the app) with execute snippets, and removed from the workbench. Screenshot image files are copied next to the destination, renamed on a clash.
- Pen only renders web pages and imports while its windows are shown. If you have hidden Pen (Cmd+H), it is shown for the duration of a browser call, behind the app you are in, then hidden again.
- Opening the workbench makes it Pen's active window. Calls without `filePath` keep going to the document that was active before.
- `spawn_agents` runs only on a document already open in the app; otherwise the error tells the agent to use its own subagents on the same file.

**App documents are saved to disk** after each successful change, through the CLI's app mode (`pen interactive -a desktop`), which reaches the app's save command without focusing it. That CLI reports "Saved" even for documents the app does not have open, so pen-multi checks the file's modification time instead of trusting the output. This also saves the user's own unsaved edits in that document.

## Parity with the official server

| Official tool | pen-multi |
|---|---|
| `read_skill` | Same; cached on disk for all agents |
| `get_style({ name, params })` | Same |
| `get_app_state()` | Same with no `filePath` (app state, selection, browser); with `filePath`, the state of that file |
| `execute` | Same; `filePath` optional as in the official server |
| `browser` | Runs in the off-screen workbench; canvas actions move the result into any file, headless or in the app. Pass `url` with any action to load and act in one step. |
| `spawn_agents` | Runs in the app on a document open there. Otherwise, or without the app, the error tells the agent to use its own subagents on the same file. |
| — | Extra: `overview`, `inspect` (design context), `open_file`, `fork_version`, `save`, `close_file`, `list_sessions` |

`browser` and `spawn_agents` need the desktop app running (the CLI cannot run the integrated browser). Agents take turns on the workbench browser through a machine-wide lock, so one agent's page load cannot land between another agent's load and read.

## Setup

```bash
npm install
npx pen login            # one-time; the CLI keeps its own session in ~/.pencil/session-cli.json
# or: export PEN_CLI_KEY=pencil_cli_...   (organization Developer Key, for CI)

claude mcp add pen-multi -s user -- node /absolute/path/to/pen-dev-mcp/src/index.js
```

It can run next to the official `pencil` server.

Requirements: Node 20+, a logged-in `@pen.dev/cli` (bundled), and for `verify` / `capture` / `import_ui` on the web a Chromium (`npx playwright install chromium`, or Google Chrome, or `PEN_MULTI_BROWSER`). Native sources need `adb` (Android) or `maestro` + Xcode's `simctl` (iOS; maestro is found in `~/.maestro/bin` and given a JDK from Homebrew or Android Studio when the MCP host's PATH has none); pen-probe needs nothing beyond the app's dev build.

### Safety

- pen-multi never opens, focuses or raises the user's windows; browsers run headless.
- The pen-probe listener binds to localhost and only while a capture runs (`PEN_MULTI_PROBE_LAN=1` for devices on Wi-Fi), and caps posted bodies at 50 MB.
- Password fields are never captured as text.
- Generated files never overwrite files they did not write: captures, token files, reference HTML, inspect specs and contact sheets all check before writing.
- Commands for devices run with argument arrays (no shell).

### Known limits

- Checked for real on the web (Chromium), an Android emulator (uiautomator and pen-probe) and an iOS 27 simulator (maestro and pen-probe, Expo SDK 57 / new architecture). The old React Native architecture (Paper) is supported by pen-probe but was only tested with fake fibers.
- Canvas/WebGL drawings and image contents are compared as pixels, not as elements.
- pen-multi does not start apps, dev servers or simulators: `verify` needs a running URL or device.
- The pen CLI's `execute` costs ~0.4 s per call; batch related work into one snippet.

## Tools

| Tool | Purpose |
|---|---|
| `read_skill`, `get_style` | Same as the official server (cached; no design file needed) |
| `overview`, `inspect` | Design context: the whole document, and one screen as data (see below) |
| `port` | Durable screen-by-screen port queue: plan, next (claims for parallel agents), done only on MATCH, status |
| `import_ui`, `sync_status` | Code → design: rebuild a running screen as a frame; which screens are verified, stale or never checked |
| `lint`, `tokens` | Design-file quality checks with safe fixes; design tokens as CSS / Tailwind / JSON / React Native, diffed against code |
| `verify`, `capture`, `contact_sheet` | Check the running implementation against the design on web, React Native, native Android/iOS or a screenshot (see below) |
| `execute` | Run a snippet against `filePath` (or the app's active document); supports `editId` + `edits` retries |
| `get_app_state` | Document state of one file, or of the app |
| `browser`, `spawn_agents` | App features; see above |
| `open_file` | Open a file explicitly, or create a new version from `sourcePath` |
| `fork_version` | Copy a file to a new path to work on a separate version |
| `save` | Write to disk (only needed with autosave off) |
| `close_file`, `list_sessions` | Manage open editors |

Screenshots from `TakeScreenshot` are returned as MCP image content.

## Design → code: `overview` and `inspect`

Agents that port a design from screenshots or memory keep the old UI and miss sections. These two tools give them the design as data; both only read.

- **`overview(filePath, { focus, refresh })`**: the big picture. Every screen as a matrix of screen + state × width, with the themes each cell is drawn in and empty cells shown; canvas bands in reading order with their titles; flows between screens inferred from arrows (or declared); components and where they are used; the type and spacing scales in use; raw colors; `note`/`context` text. `focus` zooms into one screen and lists each frame's node id.
- **`inspect(filePath, target, { detail, depth, maxLines, flavor, format, savePath, image })`**: one screen or node. A breadcrumb (variants at other widths/states/themes, flows in and out, components used), the app shell (docked header, tab bar) and the sections in order with their text, the code mapping, then an outline with one line per node: absolute position and size, fill/hug/fixed sizing, auto-layout, colors as token plus value, typography with line height in px, components and overrides, geometric clipping. Repeated rows collapse.
  - `detail: "normal"` (default) shows values in the frame's own theme, states the text defaults (font, main text color) once, and keeps whole sections under `maxLines`, listing the ones left out with the call for each; `"full"` lists every theme's value on every line; `"summary"` gives the sections only.
  - **Code mapping**: an instance of a component whose definition in code carries its marker (`data-pen="<component id or name>"`, or `"pen:<…>"` in testID / Key / accessibility id — any language, found by a text search that respects `.gitignore`) is one line naming the code component and its `file:line`; with `.pen-multi.json` `{ "tokens": { "file": "<token file>" } }`, tokens show under their code names (matched by name, then by a unique value). `components` / `tokens.map` entries there override. Components not mapped yet are listed, most used first.
  - **Variants**: a screen name matching several frames gives one base frame in full and each other width / theme / state as its differences (added, removed, changed); a theme variant that differs only through tokens is one line, and one with raw values is flagged; variants that differ in most nodes point to their own outline.
  - **Components**: `target` a component (id or exact name) to also get its API — slots, the descendants real instances override and how often, its family (same name prefix), instance count, code mapping.
  - **Image**: the first time a node is inspected in a session, a labelled render comes before the outline (for the overall look; numbers come from the outline). `image: true | false` overrides.
  - `flavor: "tailwind" | "css" | "react-native"` adds a code hint per node, following pen.dev's layout rules (e.g. `fill_container` is `flex-1` in a row parent and `w-full` in a column).
  - `format: "json"` returns everything for scripts; `"html-ref"` writes Pen's HTML export with its `box-sizing: content-box` bug fixed and layer names as `data-pen`.
  - `savePath` writes the JSON with the `.pen`'s SHA-1, so the agent can re-read it after context compaction; a stale previous spec is reported.

Screen names are parsed across conventions seen in practice (`S3 · Trang tin · sáng`, `home · day`, `★ M2 Tải file · ĐANG TẢI · 360`, `Hôm nay — rỗng`, `Vị thế — 4 mã · tablet dọc 834`); themes come from the frame's `theme` first. A `.pen-multi.json` next to the `.pen` can override with `{ "screenPattern": "<regex with named groups screen, state, width, theme>", "flows": ["path/to/flow.json"] }` (flow files hold `{ "edges": [{ "from", "to", "ev" }] }`).

The server instructions add a **port mode**: the design is the source of truth; "update the existing component" means make it match; read with `inspect`, never from screenshots or memory; list structural differences (shell, navigation, section order, missing/extra elements) before editing; ask once when project rules conflict.

`execute` responses carry `HINT:` lines for failures agents otherwise miss: a read that printed nothing, `console.log`, `await`, `TakeScreenshot` with a non-array, and interrupted snippets. Read-only snippets never mark a file dirty or trigger a save.

## Code ↔ design check: `verify`, `capture`, `contact_sheet`

`verify` compares a design screen with the running UI and returns the differences as text, so an agent cannot call a port done while the old UI is still on screen:

- **Structure** (high): design nodes missing from the UI (a missing container lists what is inside it), UI text that is not in the design (old UI left behind), section order.
- **Layout / Color / Typography** (medium, low): size, position (relative to the matched parent, so a moved section is one finding, not one per child), fill and text color (ΔE), font size and weight, line height, radius, borders, letter case.
- **Visual**: pixel regions that differ where no element finding explains them, named after the design nodes there.

The verdict is `MATCH` when there is nothing high or medium, and says what the source could not provide (`MATCH (not checked: font size, font weight)`). Each finding ends with its code location (`→ src/Header.tsx:12`, from markers; a node inside an instance points to its component's file) and, for colors, radius and type, the design token and its code name. The three worst findings also come as close-ups (design | app; `crops` sets how many).

`direction: "code-to-design"` turns the check around: the design should follow the code. Each finding with a clear cause gets a proposed `execute` operation — `Update` for text, colors, font size / weight / line height and radius (values equal to a token given as the token), `enabled: false` for a node the code no longer shows (never a deletion), `Insert` for a text only the code has — and layout is inferred per container from where the UI draws the matched children: gap, leading padding, order (`Move`), fixed sizes and absolute positions, each listing the findings it explains. Nothing is applied; the report warns when the design was also edited since the frame's last verify. The report JSON, the capture and a contact sheet (design | UI | UI with numbered findings) are written to `design-verify/` in the agent's project; add it to `.gitignore`.

```js
verify({ filePath: "app.pen", target: "Checkout", width: 390, theme: "dark",
         source: { kind: "web", url: "http://localhost:5173/checkout", steps: [{ click: "text=Cart" }] } })
```

| `source.kind` | For | How | Compares |
|---|---|---|---|
| `web` | any web app | headless Chromium via `playwright-core` (never a window): DOM + computed style, full-page screenshot; viewport = the design frame's width, `prefers-color-scheme` from the theme | everything |
| `probe` | React Native / Expo dev builds | [`probe/react-native/PenProbe.js`](probe/react-native/README.md) in the app reads the view tree and styles; screenshot from `simctl` / `adb` | everything |
| `native` | any Android / iOS app | `adb uiautomator dump` or `maestro hierarchy`, colors sampled from the screenshot | boxes, text, colors |
| `image` | anything else | a PNG you captured | pixel regions only |

Elements are paired with design nodes by **marker** first — `data-pen="Header/Title"` on web, `testID="pen:Header/Title"` in React Native, a `pen:` resource-id / accessibility id natively; the value is a node id, a layer address from `inspect`, an address suffix, or a unique layer name, and repeated rows share one marker — then by **equal text**, then containers by the texts they hold, then by box overlap. Without markers the report says so and lists what was matched only by position. Phone chrome drawn into mockups (status bar, home indicator) is skipped. Tolerances default to 4 px position/size (5 % of large boxes), ΔE 10, 1 px font size, 100 font weight, and can be overridden per call.

The web capture scrolls through the page first (so scroll-revealed content is shown), follows open shadow roots, treats a paragraph with inline children (links, `<strong>`, `<br>`) as one text, skips text hidden by ancestors or clipped by `overflow`, drops icon-font ligatures, and flags text cut by ellipsis or line clamp. `::before`/`::after` text joins its element's text, and iframes are read in place (cross-origin ones through the browser). Canvas and WebGL drawings have no elements: they are compared as pixels, like images. Fixed and sticky bars are compared against the viewport's bottom as well as the frame's.

`capture` stores a snapshot on its own (to verify again later with `snapshot`, or to look at what the UI renders); `contact_sheet` puts several verify reports into one image and returns it inline.

The browser is Playwright's Chromium if installed (`npx playwright install chromium`), else Google Chrome, else `PEN_MULTI_BROWSER`. `native` needs `adb` or `maestro` (+ Xcode's `simctl`); `PEN_MULTI_ADB`, `PEN_MULTI_XCRUN` and `PEN_MULTI_MAESTRO` point at other binaries. pen-multi never starts the app, dev server or simulator: pass a running URL or device.

## Code → design: `import_ui`, `sync_status`, routes

`import_ui` rebuilds a running screen (web URL, pen-probe, native device) as an editable frame in the .pen: painted boxes become frames, texts become text nodes with their font, color and alignment, images and icons become crops of the screenshot, colors equal to a document token use the token, and font sizes and radii use the one number token with that value. Elements whose marker names a design component come in as its instances, their texts as overrides. Flex containers (and blocks whose children stack with even gaps) become auto-layout frames where the engine reproduces the page within 2 px; the others stay absolute. Icon elements that match (by shape) an icon the document uses become icon nodes; layers are named after the code (marker, React component, aria-label, id, a name-like class); grids and wrapping rows become rows of auto layout; `components: true` turns repeated structures into a component and instances. The result says what is not on tokens yet and which repeated structures look like components. Importing a page and verifying the new frame against the same page gives MATCH.

### Where design and code stand: sync records and `sync_status`

Every `verify` MATCH records the pair in `design-sync/<frame>.json` next to the `.pen` — the design's facts, the UI's facts (texts only as hashes, so no app data enters the repo), the `.pen` hash, the code commit and the source. Commit it with the code. From then on:

- `verify` on DIFFERS says what changed on each side since the last match, tags every finding *(design changed)*, *(code changed)* or *(both)*, and its `Next:` follows: update the code, update the design (`direction: "code-to-design"`), carry each side's change to the other when they changed different nodes (`diverged`), or — when the same nodes changed on both sides — ask the user which side wins.
- `sync_status` gives every screen × width × theme one state — `in-sync`, `design-changed`, `code-changed`, `both-changed`, `match`, `differs`, `never` — with what changed (the design compared exactly; the code through the files that carry the frame's markers, changed since the recorded commit) and the next call per row, conflicts first.

### Any platform: `file` and `command` sources

Beyond web, pen-probe, native and screenshots, `verify`, `import_ui` and `port` take a snapshot from anything that can write one (a Flutter integration test, a desktop accessibility dump…): `source: { kind: "file", path }`, or `source: { kind: "command", run }`, which gets `PEN_SNAPSHOT_OUT`, `PEN_SCREENSHOT_OUT`, `PEN_WIDTH`, `PEN_HEIGHT`, `PEN_THEME`, `PEN_TARGET` and writes the snapshot there. The schema is the MCP resource `pen-multi://snapshot-schema` ([docs/snapshot-schema.json](docs/snapshot-schema.json)): only boxes are required, a source declares the rest in `fields`, and every file or command snapshot is validated. A command runs only once the user trusts it for the project — `node bin/pen-multi.js trust <project> "<command>"` — stored in `~/.pen-multi/trusted.json`, outside every repository (or with `PEN_MULTI_COMMANDS=1`).

### Project context: `project_context`

Agents design better when they know the product's intent. `project_context` returns the brief (the product, voice, visual direction and rules, written by an agent from the project's own documents with the `write-brief` prompt and approved by the user), the design system as it is now, canvas notes, and what changed in the project since the brief was stamped (sources, routes, code components, tokens, commits, files) — so an out-of-date brief is flagged and refreshed with `refresh-brief`. `.pen-multi.json` `{ "brief": { "file": "design/BRIEF.md", "sources": ["CLAUDE.md"] } }`; `project_context({ action: "stamp" })` records the approved brief and puts its outline on the canvas. The first design-tool result per file shows the brief's status.

### `doctor`, prompts, and `Next:`

- `doctor` checks a project for design ↔ code work — git repository, routes that answer, states, screen naming, code markers and component mapping, the token file, sync records not gitignored — each with its fix; it changes nothing.
- MCP prompts `port-design`, `design-from-code` and `sync-check` list the workflows in every MCP client (`prompts/`; the `pen-port` skill is the same text).
- inspect, verify, import_ui and sync_status end with one `Next:` line computed from the frame's state, and `Note:` lines flag what needs attention (the same findings three verifies in a row; a design changed since its last verify).

Routes live in `.pen-multi.json` next to the `.pen`: `{ "baseUrl": "http://localhost:5173", "routes": { "Checkout": "/checkout" } }`. With them, `verify({ target: "Checkout", source: { kind: "web" } })` needs no URL.

## Porting many screens: `port` and the `pen-port` skill

`port` keeps a durable queue per .pen (`design-verify/port-*.json`): `plan` lists every frame (screen × state × width × theme) with its route and state setup; `next` claims one (pass `claim` per agent when several work in parallel) and returns its page, state, last findings and the loop; `done` succeeds only when that frame's latest `verify` is MATCH for the current design; `skip` / `block` record why; `status` shows progress. `verify` records every run on the queue.

States are put on screen with `source.mocks` (fixture answers for matching requests: `json`, `body`, `file`, `status`, `delayMs`) and `steps`, or declared once in `.pen-multi.json`:

```json
{ "baseUrl": "http://localhost:5173",
  "routes": { "Home": "/" },
  "states": { "Home — empty": { "route": "/", "mocks": [{ "url": "**/api/today*", "json": [] }] } } }
```

The Claude Code skill `skills/pen-port` (copy it to `~/.claude/skills/pen-port`) drives the loop, with up to three subagents for large ports.

## Design quality: `lint` and `tokens`

`lint` checks one screen or the document's screens for what makes a design hard to implement or to use: text hidden under a later opaque layer, raw colors where a token exists, text contrast below WCAG AA (measured against the layers below the text; images and gradients are skipped), touch targets under 44×44 on phone screens, default layer names, off-scale font sizes and spacing, hidden or clipped leftovers (content below a scroll fold is fine), near-misaligned and unevenly spaced siblings in free layouts, engine-reported problems, and screens missing a theme most screens have. `fix: ["names", "tokens"]` applies the unambiguous fixes: rename default-named layers after their text or component, and replace a raw color with the one token that has exactly that value.

`tokens` turns the design's variables into code — `css` (custom properties per theme, with `.dark` and `prefers-color-scheme`), `tailwind`, W3C `json`, or a typed `react-native` object — and with `compare` lists the tokens a code file is missing, has changed, or has extra.

## Observability: how pen-multi performs in real use

Every tool call appends one event to `~/.pen-multi/events/<day>.jsonl`, shared by all pen-multi processes on the machine: the tool, the project and `.pen` (names and hashes only), milliseconds per step, the outcome, result tokens (text and images), for verify the verdict, finding kinds, direction and sync state, the `Next:` it suggested and whether the following call took it. Never arguments, texts or code. Kept 30 days, at most 20 MB a day; `PEN_MULTI_EVENTS=0` turns it off.

```sh
node bin/pen-multi.js report              # last 7 days, all projects
node bin/pen-multi.js report --days 30 --project shop --json
```

The report shows calls, errors, p50 / p95 latency and the dominant step per tool, result tokens, verify runs until MATCH and frames that never got there, the most frequent findings, how often agents followed `Next:`, reminders, and time spent waiting for other agents on the pen.dev app. `npm run eval` attaches the same numbers to each agent run.

## Many agents, many projects

Each Claude Code session starts its own `pen-multi-mcp` process, with the session's project as its working directory. Subagents share their parent's process.

- **Paths**: relative `filePath`s resolve against the agent's project, so every agent can use `design.pen` and get its own file. Every response starts with `File: <absolute path>`.
- **One agent per file**: a lock in `~/.pen-multi/locks` stops two agents from editing the same file. The error names the other agent's project; use `fork_version` to work on a copy in parallel. Locks of crashed agents are reclaimed automatically, and autosaved work survives the crash.
- **Busy files are never evicted**: a file stays open from the moment a call for it arrives until that call finishes, so subagents sharing one server cannot pull a file away from each other. Calls on the same file run one at a time.
- **Memory limits**: at most `PEN_MULTI_MAX_SESSIONS` (4) files per agent and `PEN_MULTI_GLOBAL_MAX_SESSIONS` (8) machine-wide. When full, the least recently used idle file of that agent is saved and closed; if none is idle, the call waits up to `PEN_MULTI_WAIT_FOR_SLOT_SECONDS` (120), then fails with a list of which agents hold which files. `list_sessions` shows the machine-wide picture.
- **Shared skill cache**: `read_skill`/`get_style` answers are cached in `~/.pen-multi/cache/<cli version>/` for all agents, so agents do not start an editor just to read docs.
- **Pre-warm**: 2 s after a server starts, it starts an editor for the project's design file (the only `*.pen` in the project root, or the files listed as `"prewarm": ["design/app.pen"]` in `.pen-multi.json` there), so the first call skips editor startup (~2 s → ~0.4 s). The warm editor takes no file lock and blocks no one; it counts toward both limits but is given up first when any agent needs a slot, is reloaded if the file changed on disk before its first call, and closes after `PEN_MULTI_PREWARM_MINUTES` (3) unused. Only one process pre-warms a given file, and files open in the app are skipped. `list_sessions` shows it as `starting`, then `warm`, and says under `prewarm` what was done or why it was skipped.
- **Slow machines**: an editor starts in ~3 s normally, but took 25–30 s in testing on a heavily loaded machine. If tool calls time out on the client side, raise the client's MCP tool timeout (for Claude Code, the `MCP_TOOL_TIMEOUT` environment variable, in ms).

## Behaviour

- **Autosave**: every successful change is saved in the background right after the call returns (`PEN_MULTI_SAVE_DELAY_MS`, default 1500 ms of no further writes; bursts coalesce into one save). `save`, `close_file`, `fork_version`, eviction and shutdown flush first. Call `save` before reading a `.pen` from disk or committing it. A failed save is reported on the next call for that file and in `list_sessions`.
- **Slow calls**: any tool call over `PEN_MULTI_SLOW_MS` (3000) is logged to `~/.pen-multi/slow.jsonl` with where its time went (routing, the engine or the app, saving) and how many other agents were using the pen.dev app at that moment; `list_sessions` shows the latest with a likely cause. A call that waited behind other agents' app calls says so in its response (the app runs one call at a time for everyone).
- **App state**: the list of app windows is read on every call; the app's active document is cached for `PEN_MULTI_APP_STATE_TTL_MS` (2000 ms) and re-read whenever a write depends on it. `list_sessions` reports median/p90 timings for routing, calls and saves.
- **Timeouts**: a call that runs past `PEN_MULTI_CALL_TIMEOUT_MS` stops that file's editor (its late output would otherwise leak into the next call); the next call reopens the file from disk.
- **Paths** are resolved through symlinks, so `/tmp/x.pen` and `/private/tmp/x.pen` share one editor and one lock.
- **Idle files** close after 15 minutes. Each open file costs roughly 400–650 MB of RAM.
- **Call cost**: every `execute` costs ~330 ms inside the CLI however little it does, so batch related reads and writes into one snippet. `overview` reads the whole document in one call.
- **Snippet run time**: the CLI's sandbox interrupts a snippet that runs for too long (`InternalError: interrupted`); split long work into several `execute` calls.
- **Desktop app**: a file open in the app is edited in the app, never headlessly. If a file is already open headlessly when the user opens it in the app, calls are refused until one side lets go, instead of the two editors overwriting each other. A file another agent holds headlessly is never pulled into the app. The server also warns when a source file is 0 bytes on disk (its content may exist only unsaved in the app).
- `Export()` relative paths resolve next to the `.pen` file. Generated images are written to `images/` next to it.

| Env var | Default | |
|---|---|---|
| `PEN_MULTI_AUTOSAVE` | `1` | `0` keeps changes in memory until `save` |
| `PEN_MULTI_SAVE_DELAY_MS` | `1500` | Idle time before a background save |
| `PEN_MULTI_APP_STATE_TTL_MS` | `2000` | How long the app's active document is cached |
| `PEN_MULTI_MAX_SESSIONS` | `4` | Open files per agent |
| `PEN_MULTI_GLOBAL_MAX_SESSIONS` | `8` | Open files across all agents on the machine |
| `PEN_MULTI_WAIT_FOR_SLOT_SECONDS` | `120` | How long a call waits for a free slot |
| `PEN_MULTI_STARTUP_TIMEOUT_MS` | `180000` | Editor startup timeout |
| `PEN_MULTI_IDLE_MINUTES` | `15` | Idle time before a file is saved and closed |
| `PEN_MULTI_CALL_TIMEOUT_MS` | `300000` | Per-call timeout |
| `PEN_MULTI_SLOW_MS` | `3000` | Calls slower than this are logged with their breakdown |
| `PEN_MULTI_PREWARM` | `1` | `0` never starts an editor ahead of use |
| `PEN_MULTI_PREWARM_MINUTES` | `3` | How long an unused pre-warmed editor stays open |
| `PEN_MULTI_PREWARM_DELAY_MS` | `2000` | Delay after server start before pre-warming |
| `PEN_MULTI_BROWSER` | Playwright's Chromium, then Chrome | Browser executable for `verify`/`capture` web sources |
| `PEN_MULTI_PROBE_PORT` | `7357` | Port pen-probe polls during a capture |
| `PEN_MULTI_PROBE_LAN` | `0` | `1` listens on the LAN during probe captures (devices on Wi-Fi) instead of localhost only |
| `PEN_MULTI_ADB`, `PEN_MULTI_XCRUN`, `PEN_MULTI_MAESTRO` | from `PATH` | Tools for `native` / `probe` sources |
| `PEN_MULTI_HOME` | `~/.pen-multi` | Locks and the shared cache |
| `PEN_CLI_PATH` | bundled dependency | Path to another `@pen.dev/cli` `dist/index.mjs` |
| `PEN_MULTI_APP` | `1` | `0` never uses the desktop app |
| `PEN_MULTI_APP_SERVER` | the app's bundled `mcp-server` | Path to the app's MCP server binary |
| `PEN_MULTI_APP_AGENT` | `claudeCodeCLI` | Agent name reported to the app |
| `PEN_MULTI_WORKBENCH` | `~/.pen-multi/workbench/workbench.pen` | The off-screen scratch document for browser calls |
| `PEN_MULTI_APP_OPEN_CMD` | `["open","-g","-a","Pen"]` | JSON command that opens the workbench in the app |
| `PEN_MULTI_APP_OPEN_TIMEOUT_MS` | `90000` | How long to wait for the app to open the workbench |
| `PEN_MULTI_APP_UI` | `1` | `0` skips macOS UI scripting (hiding Pen, moving the workbench); needs System Events access |

## Limitations

- Headless files have no live view: open them in the app afterwards to look at them.
- The workbench window stays open (off screen) while Pen runs; closing it is fine, it is reopened when needed.
- Moving the workbench and showing/hiding Pen use System Events, which macOS may ask to allow once.
- Documents opened in the app from its dashboard (not from a file) may not be detected as open, since detection reads each window's launch file; such a file is then edited headlessly.
- `spawn_agents` has only been tested against a fake app; its designer agents run on the app's own AI settings.
- Responses are read from the CLI's interactive shell output, so a CLI update could change the format. The CLI version is pinned in `package.json`; run `npm test` after bumping it.
- `Generate(...)`, `get_style` and login go through pen.dev's backend like the app does.

## Benchmark

```bash
npm run bench -- path/to/a.pen [path/to/b.pen ...]   # works on temp copies; the originals are never touched
```

Reports per file: first open, read, write, save, `overview` cold/cached, `inspect`; then all files edited in parallel by separate server processes, the same-file conflict latency, that every write reached disk, and the first call on a pre-warmed file. Run it before and after performance changes.

## Tests

```bash
npm test   # needs a logged-in CLI; ~1 min normally, several on a loaded machine
node --test test/pool.test.js test/app.test.js test/shell.test.js   # fake CLI/app and unit tests, no login needed
# test/workbench.test.js uses a fake app backed by real headless editors (needs login)
```
