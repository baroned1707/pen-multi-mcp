# pen-multi: project context that stays current

## Why

pen-multi gives agents the structure of a project: screens, routes, states, components, tokens, and where design and code stand. It does not give them the product's intent: what the app is for, who uses it, its voice, its visual direction, and its rules. Designing a new screen or reworking one without that intent gives correct but off-brand work.

Projects already have this intent, spread over large documents (trading-agent `CLAUDE.md` is 130 KB; driversafe has `docs/DESIGN_BRIEF.md` among others). The code also changes during development, so any summary goes out of date.

The MCP server has no model of its own. An agent writes the summary; pen-multi stores it, serves it, and says precisely when and where it is out of date.

## Parts

### 1. The brief (authored, in the repository)

- **Location.** `.pen-multi.json` declares `"brief": { "file": "design/BRIEF.md", "sources": ["CLAUDE.md", "docs/UX-REDESIGN.vi.md"] }`. The default file is `design/BRIEF.md`, next to the `.pen`.
- **Template.** The prompt suggests these sections:
  - product (what it does, for whom, main jobs);
  - language and voice;
  - visual direction;
  - rules (do / don't, each pointing at its source);
  - platforms, widths and themes;
  - patterns (navigation; empty, error and loading states);
  - open questions.
- **Length.** Under about 8 KB.
- **Language.** The language of the project's documents; the prompt asks the user when they are mixed.

### 2. The stamp (what the brief was written against)

- `project_context({ action: "stamp" })` records a snapshot in `design-sync/brief-stamp.json`, written atomically under a lock and meant to be committed:
  - the git commit;
  - a SHA-1 per source document;
  - the routes;
  - the code components found by markers;
  - the token names.
- On stamp, a text note named "Project brief" holding the digest is written or updated on the canvas for designers. `note: false` skips it, and the result says where the note went.

### 3. `project_context({ filePath, detail: "digest" | "full" })`

- **Brief:** the digest (headings plus their first lines, about 40 lines) or the full text, bounded.
- **Always current, computed on each call and cached by hash and mtime:**
  - the document's tokens with their values per theme;
  - the component, type-scale and spacing summary from overview's analysis;
  - the notes and context on the canvas;
  - the code mapping (components mapped, token file).
- **Since the brief:**
  - the commits since the stamp (subjects, bounded);
  - files added and removed (at most 20);
  - changed-file counts per top-level folder;
  - sources changed;
  - routes, code components and tokens added or removed.

  The brief counts as possibly out of date when a source, a route, a code component or a token changed. Commits and files alone are information only. Without git, the file and commit parts are skipped.
- **Next:**
  - no brief: the `write-brief` prompt;
  - possibly out of date: the `refresh-brief` prompt with the change list;
  - else: nothing to do.

### 4. Delivery

- **First-time attach.** The first overview, inspect, execute, import_ui or lint result for a file in a server process gets a "Project brief" section: the digest and the since-the-brief status. Subagents share a process, so the instructions, prompts and skill also say: before designing a new screen or changing the design, call `project_context`.
- **Prompts.**
  - `write-brief`: read `CLAUDE.md`, the README, docs about design, brief, brand or UX, and the canvas notes; draft with the template; ask the user to approve; then stamp.
  - `refresh-brief`: update only the sections the change list touches; ask; stamp.
- **doctor** warns when there is no brief, or when it is possibly out of date.

## Measurement

Eval task "new screen": the agent designs a new trading-agent screen, with and without the brief. It is scored on:

- lint findings;
- the share of fills on tokens;
- component reuse;
- language and rules the brief states that can be checked.

An LLM judge is optional, and its scores are reported as weak evidence.

## Tests

- stamp and diff:
  - sources, routes, components and tokens;
  - git commits and files;
  - no git;
- the digest is bounded;
- first-time attach happens once per file;
- a missing or stale brief gives the right Next;
- the note is written on stamp and skipped with `note: false`;
- doctor;
- the prompts are listed.
