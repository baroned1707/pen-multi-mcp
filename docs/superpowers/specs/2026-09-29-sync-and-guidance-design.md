# pen-multi: design ↔ code sync, any-platform sources, doctor, and agents that use the tools well

Scope: everything serves the two directions — design → code and code → design. Not in scope: a CI check (the sync files it would need are plain JSON in the repo, so one can be built on them later).

Principles from the agent-context spec apply: contracts not platforms, honest coverage, actionable and bounded output, durable truth in the repo, safe for many agents and unfamiliar repos.

## Phase 1: measure agent behaviour first

Tier 2 eval (`npm run eval`) records each run's tool calls (`claude -p --output-format stream-json --verbose`) and scores the process, not only the result:

- inspected the frame before editing code;
- put markers in the code;
- followed the `Next:` / finding suggestions;
- used the right `direction`;
- verify runs until MATCH.

A new task, **both-changed**: the design and the code were both edited since the last MATCH, differently. A good run stops and reports the conflict instead of overwriting either side.

The 1.3.0 behaviour is recorded as the baseline (dry run by default; the cost estimate is printed before any run).

## Phase 2: agents use the tools well

1. **Descriptions say when.** Every tool description starts with "Use when … / Not for …". The server instructions become a short decision table: goal → tool.
2. **One `Next:` line** ends every inspect, verify, sync_status, import_ui and port output. One function, `nextStep(state)`, computes it from the frame's state (never verified / differs / design changed / code changed / both / in sync), so tools never contradict each other.
3. **State-based reminders.** A `Note:` line, never blocking. It is based on the frame's state, not on which agent acted, because subagents share a server process:
   - the design of this frame was edited through this server since its last verify or lint;
   - verify of this frame returned the same findings three times in a row: change approach, or check the state and route;
   - import_ui created this frame and it was never verified.
4. **MCP prompts** `port-design`, `design-from-code` and `sync-check`, with arguments (filePath, screen). Every MCP client lists them as commands. `skills/pen-port/SKILL.md` is generated from the same template, and a test keeps the two identical.

## Phase 3: sync state — where design and code stand since the last MATCH

**Record.** Every verify MATCH writes `design-sync/<screen>-<width>-<theme>-<hash6>.json`, in the folder of the `.pen` (next to `.pen-multi.json`), meant to be committed. It holds:

- the `.pen` SHA-1;
- the frame's id, name, width and theme;
- coverage (the fields the source provided);
- the source (url / state / kind; mocks by path);
- the code's git commit, and whether the tree had uncommitted changes;
- per matched design node:
  - address;
  - design facts: box, text, colors, font, radius;
  - UI facts: box, colors, font, radius, and **text as a SHA-1 only**, so no user data from the running app enters the repo.

Files are written as tmp + rename, with numbers rounded and keys sorted. DIFFERS never overwrites a record. A record is derived data: after a merge conflict, verify again to regenerate it (the file says so).

**sync_status** gives each screen frame one state:

- **design side**: an unchanged `.pen` SHA-1 means unchanged. Otherwise the frame is read again (a bounded number per call, `maxReads`) and compared by address with the record, exactly (design data has no capture noise): nodes added, removed, and properties changed (from → to), plus the frame's own fill.
- **code side, cheap**: the marker index maps the screen to its files; `git diff --name-only <record commit>` tells whether they changed. When the screen has no markers, or the record's commit is not in history, it says so.
- **code side, deep**: `verify` itself. On DIFFERS it compares the capture with the record's UI facts (compare's tolerances) and lists what changed in the code; sync_status points at it for rows whose code side is unknown or changed.
- **states**: `in sync` · `design changed` · `code changed` · `both changed` · `differs` · `never`, each with its `Next:` (verify; verify with direction code-to-design; ask the user which side wins, with both change lists).

**verify** uses the record: when DIFFERS, each finding is tagged *(design changed)*, *(code changed)* or *(both)* since the last match, and `Next:` follows the tag.

## Phase 4: sources for any platform — `file` and `command`, and a published schema

- `source: { kind: "file", path }`: a snapshot written by anything.
- `source: { kind: "command", run, cwd?, timeoutMs? }`: pen-multi runs the command with `PEN_SNAPSHOT_OUT`, `PEN_SCREENSHOT_OUT`, `PEN_WIDTH`, `PEN_HEIGHT`, `PEN_THEME`, `PEN_TARGET` and `PEN_STATE`. The command writes the snapshot and screenshot there.
- **Off by default.** A command runs only when it is trusted for this project in `~/.pen-multi/trusted.json` (project path + SHA-256 of the command), or when the server runs with `PEN_MULTI_COMMANDS=1`. Trust is outside the repository, so a repository cannot trust itself. It is added by the user with `npx pen-multi trust <project> "<command>"`; doctor prints that line and never writes trust.
- **Schema v1:**
  - it is published as the MCP resource `pen-multi://snapshot-schema` and as `docs/snapshot-schema.json`;
  - `box` is required per element; everything else is optional and declared in `fields`;
  - within v1, fields are only added;
  - every snapshot, including those from the built-in adapters, is validated, and an error names the field and quotes the schema part;
  - `read_skill` stays the official skill, unchanged.
- verify, import_ui, port and sync accept every kind. Coverage follows `fields`.

## Phase 5: `doctor`

`doctor({ filePath })` checks each item (✅ / ⚠️ / ❌), gives the fix for each, and changes nothing:

- a git repository;
- `.pen-multi.json`: routes that open, states that are missing, a `screenPattern` if frames look merged;
- marker coverage of screens and components;
- the token file, and how many tokens are mapped;
- one capture of one screen, time-limited;
- a command source's snapshot against the schema;
- `design-sync/` is not gitignored.

## Phase 6: measure again

The tier-2 behaviour metrics and results against the phase 1 baseline go into the changelog, with n.

## Tests

- `nextStep` for every state;
- reminders triggered by state;
- prompts and SKILL.md identical;
- sync:
  - a record is written on MATCH and only then;
  - text is hashed;
  - the design change list;
  - the cheap code check through git;
  - deep capture with tolerances;
  - the both-changed state;
  - finding tags;
- file and command sources:
  - schema validation errors;
  - a command refused when untrusted, run when trusted;
  - the environment passed to the command;
- doctor on a prepared project;
- eval task fixtures start in the intended state.
