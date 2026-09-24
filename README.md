# pen-multi-mcp

An MCP server for editing pen.dev `.pen` files **without the pen.dev desktop app**, built for **many agents working on many projects at the same time**, with **file versions** kept apart.

The official `pencil` MCP server forwards every call to the single running desktop app. That means:

- the app must be open, with the target document open in a window;
- a `filePath` that is not open in the app silently falls back to the app's *active* document, so edits can land in the wrong project.

`pen-multi-mcp` drives the official [`@pen.dev/cli`](https://www.npmjs.com/package/@pen.dev/cli) in headless mode instead. Each `.pen` file gets its own `pen interactive` process, keyed by its absolute path, so files cannot be mixed up and nothing needs a GUI. The CLI is used as-is: it is not modified, patched or bundled.

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
| `execute` | Run a snippet against `filePath`; opens the file on demand; supports `editId` + `edits` retries |
| `get_app_state` | Document state of one file |
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
- **Desktop app**: the server warns when a file is also open in the desktop app, and when a source file is 0 bytes on disk (its content may exist only unsaved in the app). Do not edit the same file in both places; they overwrite each other.
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

## Limitations

- No `browser` tool (desktop-only) and no live view: open the file in the app afterwards to look at it.
- Responses are read from the CLI's interactive shell output, so a CLI update could change the format. The CLI version is pinned in `package.json`; run `npm test` after bumping it.
- `Generate(...)`, `get_style` and login go through pen.dev's backend like the app does.

## Tests

```bash
npm test   # needs a logged-in CLI; ~1 min normally, several on a loaded machine
node --test test/pool.test.js test/shell.test.js   # fake-CLI and unit tests only, no login needed
```
