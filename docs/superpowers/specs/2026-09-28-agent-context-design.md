# pen-multi: context that lets agents port correctly (design → code and code → design)

## Problem

Agents port designs to code and bring code back into designs using what pen-multi's tools return. The tools already give exact values, which is the right basis. But agents still:

- rewrite components that already exist in the code;
- use raw values where the code has tokens;
- inspect 20 frames of one screen one by one;
- cannot find the code behind a verify finding.

In the other direction, imported screens are absolute-positioned boxes with raw values, and nothing tells the agent what changed in code.

Measured on `near-me.pen` (182 screens):

- `inspect` of one 390 px screen (64 nodes) is about 2.7k tokens. Every line repeats both themes' values and the font family.
- `inspect` returns no image.
- No output knows the code's names for components or tokens.
- `overview` merges 20 frames of "S1" (states such as "rỗng", "tấm nấc mở" written into the names) into one row, because the file has no `screenPattern`.

### Evidence on context formats

The formats agents work well with, from benchmarks and vendor guidance:

- **Numbers as text, with token names.** Models read positions and colors from images poorly. Design2Code's weakest scores are position and color, and one study found accuracy dropping from 68% to 20% when answers had to be given in pixel coordinates.
- **Images only for the overall look and for checking the result.** Images should be labelled and cropped to the part that matters. Screenshot-only input is the weakest (OSWorld: 5.3% vs 12.2% with an accessibility tree).
- **A text tree with short, stable refs.** It is cheaper and more reliable than raw HTML (often >20k tokens) or images (1.5–4.8k tokens each).
- **Progressive disclosure:** a map, then the chosen node, then an image. Figma's MCP follows this order, and long dumps lose their middle.
- **Output in the target code's vocabulary.** A screenshot cannot say which of several same-valued tokens is meant.

Weakly supported:

- self-correction from before/after images (small gains);
- the choice between JSON, YAML and Markdown (no consistent winner).

## Principles (apply to every change below)

1. **Contracts, not platforms.** The core knows the design model and the UI snapshot. Sources plug in through the snapshot contract; no platform branches are added to the core. The existing `inspect` `flavor` code hints (tailwind/css/react-native) stay but are frozen: no new flavors.
2. **Self-describing, versioned, compatible contracts.** Within a version, fields are only added, and only as optional.
3. **Honest coverage.** A verdict lists what was and was not checked. Nothing unmeasured counts toward MATCH.
4. **Actionable, bounded output.** Every finding says what, where (id, name, `file:line`), how bad, and the next call. Output fits the client's limit, which is 25k tokens in Claude Code, and states what was left out and how to get it.
5. **Durable truth lives in the repo, derived where possible.** Mappings are derived from code. Stored config holds only overrides.
6. **Safe for many agents and unfamiliar repos.** Anything context-dependent, such as routes, markers or `screenPattern`, is written by the agent. pen-multi checks it and points at gaps; it does not guess.

## Phase 1: measure first

Tier 1 is offline metrics, run on fixtures in `npm test` as regression guards. The same metrics also run in `npm run bench -- context <files>` on read-only copies of real files (near-me, p2p-print-3d, driversafe); these are not part of the tests, which must not depend on local projects.

- **Completeness.** Every property needed to build a node must appear in compact `inspect` output. The properties are box, layout, token or value for fill, stroke, radius, text, font and line height, and component. Recall is measured against the full JSON spec and must be 100%.
- **Size.** Tokens per inspected screen and the share of repeated lines. Targets are set from the v1.2.0 baseline.
- **Mapping and `file:line` accuracy,** on fixtures with known answers.
- **Round trip.** Import, then verify, must MATCH. The share of imported nodes that are instances or token-bound is reported.

Tier 2 is `npm run eval`, opt-in and costly:

- Three tasks on fixtures:
  - port a screen;
  - update a design after a code change;
  - fix a screen that DIFFERS.
- Each task runs as headless `claude -p` against two pen-multi checkouts: tag `v1.2.0` and the new branch.
- `n` runs per side is configurable.
- Metrics:
  - MATCH reached;
  - verify runs;
  - total tokens;
  - raw values or wrong tokens in the resulting code.
- Before running, it prints an estimate of token cost and asks for confirmation.
- Results go to `bench/eval-<date>.json`, with `n` stated. Small `n` is indicative, not significant.
- Fixtures only; no user project content is sent.

The v1.2.0 baseline is recorded before any change below.

## Phase 2: design → code

### Mapping design ↔ code

- **Components are derived from markers on component definitions in code.** For example, `data-pen="GmCFh"` on the root of `Button.tsx`, or `testID="pen:GmCFh"`. They are found by a string search of the repo. The search:
  - respects `.gitignore`;
  - is cached by file mtimes;
  - is time-limited.
- **Tokens are derived from the project's token file,** matched by value and then by name (the logic of `tokens compare`), and cached by that file's mtime.
- **`.pen-multi.json` holds overrides only,** keyed by id with the name as a label:

  ```json
  "components": { "GmCFh": { "name": "C/Nut/Chinh", "code": "Button", "props": { "variant": "primary" }, "file": "web/components/Button.tsx" } },
  "tokens": { "file": "web/app/tokens.css", "map": { "$accent": "--accent" } }
  ```

- **pen-multi checks the mapping** and reports:
  - files that do not exist;
  - code names not found in their file;
  - tokens missing from code;
  - unmapped components, ordered by instance count.

  These checks come from `tokens` (the existing tool) and from `inspect` on a component.

### `inspect`

- **`detail: "summary" | "normal" | "full"`, default `normal`:**
  - Only the frame's own theme's values are shown.
  - Values shared by most nodes (font family, main text color) become a "defaults" line at the top.
  - An instance of a mapped component is one line: `Ô điểm neo → Button variant=primary (web/components/Button.tsx) · 358×44 · overrides: text "Đại học Bách Khoa"`.
  - Tokens show the code name and value: `fill --accent (#1A56DB)`.
- **The limit cuts at section boundaries**, never mid-line. The output then lists the sections left out and the call that gets each one (`inspect { target: <section id> }`). `maxLines` stays.
- **Image.** A labelled render ("Design: S1 · Bản đồ · 390 · sáng") comes before the outline the first time a frame is inspected in a session. First time means by id and .pen sha. `image: true|false` overrides this. Tall frames are cropped per section. Clients without image support get the text only.
- **Variants.** When the target is a screen with several frames (widths × themes × states), the output is one base frame plus, per other frame, its differences:
  - nodes added or removed;
  - layout changes;
  - property changes.

  If a variant's differences exceed about 50% of its outline, that variant is given in full, with the reason. A theme variant is checked to differ only through tokens; any difference not made through a token is flagged.
- **A component as target** returns its API instead of an outline:
  - slots;
  - overridable descendants, taken from real instances' `descendants`;
  - its family by `/` name prefix (e.g. `C/Nut/*`);
  - instance count;
  - the code mapping.

### `verify`

- **Each finding** carries:
  - `node` (id and name);
  - `property`;
  - `expected`, with the code token name;
  - `actual` and `delta`;
  - `code`: `file:line` from the marker search. A node inside an instance points to the component's file. When no static location is found, the finding says so, e.g. for a computed marker.
- **Labelled crops** ("expected | actual") of the N worst regions (default 3), not the whole screen.
- **The verdict states coverage,** e.g. `MATCH · checked: boxes, text, colors · not checked: font size, weight (source does not provide them)`. The fields a source declares drive this; the rules that were skipped are no longer silent.

### `overview` and `port next`

- **`overview`** detects rows where frames that differ in more than width or theme share one screen row. It suggests writing a `screenPattern`, with an example built from the actual names. It does not guess states itself.
- **`port next`** uses the compact `inspect` output, the mappings and the new finding format.

## Phase 3: code → design

### `import_ui`

- **Instances.** An element whose marker or source component maps to a design component becomes an instance of that component, with overrides for text and color. It is no longer a set of loose nodes.
- **Tokens.** Colors, spacing, radius, font size and line height are bound through the token mapping, not only fills.
- **Layout.** The snapshot contract gains an optional `layout` per element: direction, gap, padding, align, justify, wrap. The web adapter fills it from flexbox. Other sources may provide it.
  - Containers with `layout` are built as auto-layout. The engine lays them out and the resulting boxes are compared with the snapshot. A container off by more than the tolerance falls back to absolute placement.
  - The result reports `N auto-layout containers, M absolute (reasons)`.
  - The import → verify round trip must stay MATCH.
- **The result says what is not clean:** nodes with raw values, and repeated structures that look like a component but are not mapped.

### `verify` with `direction: "code-to-design"`

- **Same findings, each with a proposed `execute` operation** when the cause is clear:
  - color, text, font, radius → `Update` of that node;
  - gap or padding, when the finding is attributed to a container → `Update` of the container;
  - elements present only in code → an import fragment inserted at the right parent;
  - elements gone from code → hide the node (`enabled: false`) with a reason. Deletion is never proposed.
- **Position differences with no clear cause** get a description and no operation.
- **Operations target the frame of the captured theme.** A value that equals a token is proposed as that token. A value that matches no token is proposed raw and flagged "outside the design system".
- **pen-multi never applies operations itself.** The agent applies chosen ones with `execute` and verifies again.
- **Concurrent edits.** If the .pen changed since the frame's last verify, the output warns that the design was also edited, and asks the agent to confirm the direction before applying. Full two-sided change tracking needs baselines (spec B).

## Phase 4: measure again

Tier 1 and tier 2 run against the v1.2.0 baseline. The results, with `n`, go into the CHANGELOG and the release notes.

## Out of scope (spec B)

- baselines;
- change tracking since the last MATCH;
- `check` for CI;
- the `command` snapshot source and published snapshot schema;
- `doctor`.

## Tests

Each phase ships with tests, and the full suite must show `# fail 0` before a commit. Specifically:

- **Mapping:**
  - derivation from markers in several file types (tsx, dart, swift, html);
  - overrides;
  - missing files and names.
- **`inspect`:**
  - theme filtering;
  - defaults hoisting;
  - section cut with a follow-up list;
  - variants diff with fallback;
  - theme-only-through-tokens flag;
  - component API;
  - image first time only.
- **`verify`:**
  - `file:line` for markers and for nodes inside instances;
  - no static location;
  - coverage line;
  - crops limited to N.
- **`import_ui`:**
  - instances from mapping;
  - tokens for spacing and radius;
  - auto-layout with a per-container fallback;
  - round trip MATCH.
- **Reverse `verify`:**
  - operations only for clear causes;
  - hide, never delete;
  - theme frame;
  - concurrent-edit warning.
- **Metrics:** recall of 100% on fixtures.
