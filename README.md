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
| — | Extra: `open_file`, `fork_version`, `save`, `close_file`, `list_sessions` |

`browser` and `spawn_agents` need the desktop app running (the CLI cannot run the integrated browser). Agents take turns on the workbench browser through a machine-wide lock, so one agent's page load cannot land between another agent's load and read.

## Setup

```bash
npm install
npx pen login            # one-time; the CLI keeps its own session in ~/.pencil/session-cli.json
# or: export PEN_CLI_KEY=pencil_cli_...   (organization Developer Key, for CI)

claude mcp add pen-multi -s user -- node /absolute/path/to/pen-dev-mcp/src/index.js
```

It can run next to the official `pencil` server.

## Tools

| Tool | Purpose |
|---|---|
| `read_skill`, `get_style` | Same as the official server (cached; no design file needed) |
| `execute` | Run a snippet against `filePath` (or the app's active document); supports `editId` + `edits` retries |
| `get_app_state` | Document state of one file, or of the app |
| `browser`, `spawn_agents` | App features; see above |
| `open_file` | Open a file explicitly, or create a new version from `sourcePath` |
| `fork_version` | Copy a file to a new path to work on a separate version |
| `save` | Write to disk (only needed with autosave off) |
| `close_file`, `list_sessions` | Manage open editors |

Screenshots from `TakeScreenshot` are returned as MCP image content.

## Many agents, many projects

Each Claude Code session starts its own `pen-multi-mcp` process, with the session's project as its working directory. Subagents share their parent's process.

- **Paths**: relative `filePath`s resolve against the agent's project, so every agent can use `design.pen` and get its own file. Every response starts with `File: <absolute path>`.
- **One agent per file**: a lock in `~/.pen-multi/locks` stops two agents from editing the same file. The error names the other agent's project; use `fork_version` to work on a copy in parallel. Locks of crashed agents are reclaimed automatically, and autosaved work survives the crash.
- **Busy files are never evicted**: a file stays open from the moment a call for it arrives until that call finishes, so subagents sharing one server cannot pull a file away from each other. Calls on the same file run one at a time.
- **Memory limits**: at most `PEN_MULTI_MAX_SESSIONS` (4) files per agent and `PEN_MULTI_GLOBAL_MAX_SESSIONS` (8) machine-wide. When full, the least recently used idle file of that agent is saved and closed; if none is idle, the call waits up to `PEN_MULTI_WAIT_FOR_SLOT_SECONDS` (120), then fails with a list of which agents hold which files. `list_sessions` shows the machine-wide picture.
- **Shared skill cache**: `read_skill`/`get_style` answers are cached in `~/.pen-multi/cache/<cli version>/` for all agents, so agents do not start an editor just to read docs.
- **Slow machines**: an editor starts in ~3 s normally, but took 25–30 s in testing on a heavily loaded machine. If tool calls time out on the client side, raise the client's MCP tool timeout (for Claude Code, the `MCP_TOOL_TIMEOUT` environment variable, in ms).

## Behaviour

- **Autosave**: after every successful `execute`, the document is saved to its `filePath`.
- **Timeouts**: a call that runs past `PEN_MULTI_CALL_TIMEOUT_MS` stops that file's editor (its late output would otherwise leak into the next call); the next call reopens the file from disk.
- **Paths** are resolved through symlinks, so `/tmp/x.pen` and `/private/tmp/x.pen` share one editor and one lock.
- **Idle files** close after 15 minutes. Each open file costs roughly 500–650 MB of RAM.
- **Snippet run time**: the CLI's sandbox interrupts a snippet that runs for too long (`InternalError: interrupted`); split long work into several `execute` calls.
- **Desktop app**: a file open in the app is edited in the app, never headlessly. If a file is already open headlessly when the user opens it in the app, calls are refused until one side lets go, instead of the two editors overwriting each other. A file another agent holds headlessly is never pulled into the app. The server also warns when a source file is 0 bytes on disk (its content may exist only unsaved in the app).
- `Export()` relative paths resolve next to the `.pen` file. Generated images are written to `images/` next to it.

| Env var | Default | |
|---|---|---|
| `PEN_MULTI_AUTOSAVE` | `1` | `0` keeps changes in memory until `save` |
| `PEN_MULTI_MAX_SESSIONS` | `4` | Open files per agent |
| `PEN_MULTI_GLOBAL_MAX_SESSIONS` | `8` | Open files across all agents on the machine |
| `PEN_MULTI_WAIT_FOR_SLOT_SECONDS` | `120` | How long a call waits for a free slot |
| `PEN_MULTI_STARTUP_TIMEOUT_MS` | `180000` | Editor startup timeout |
| `PEN_MULTI_IDLE_MINUTES` | `15` | Idle time before a file is saved and closed |
| `PEN_MULTI_CALL_TIMEOUT_MS` | `300000` | Per-call timeout |
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

## Tests

```bash
npm test   # needs a logged-in CLI; ~1 min normally, several on a loaded machine
node --test test/pool.test.js test/app.test.js test/shell.test.js   # fake CLI/app and unit tests, no login needed
# test/workbench.test.js uses a fake app backed by real headless editors (needs login)
```
