# Design context: port guidance, execute hints, `overview`, `inspect`

Sub-project 1 of the design ↔ code roadmap (next: `lint` + `names`, then `capture` + `verify` + `contact_sheet`, `tokens`, code → design, `critique`).

## Problem

Evidence from four projects (near-me, p2p-print-3d, driver-app, trading-agent):

- **Agents port from screenshots and memory, not data.** trading-agent's port phase made 13 Pen calls, all `TakeScreenshot`; its attempts to read structure failed silently (`OK` with no `Print`, `await` syntax error, `console` undefined, `TakeScreenshot` with a non-array) and it never retried. It admitted porting four frames "from my own description table" and "from memory".
- **Agents keep the old UI.** ~350 anchored string patches, the app shell never ported, "bend the drawing into the existing vocabulary". pen.dev's own guide says "if the element already exists in the codebase, update it, not generate a new one", read as "keep it".
- **The big picture is invisible.** `get_app_state` lists 10 roots then "+N others"; near-me has 375 roots, p2p 564. Agents rebuilt existing screens and picked wrong frames.
- **Every project re-wrote the same measurement code** (~627 hand-written bounds visitors) and fell into the same traps: parent-relative bounds, instances hidden without `resolveInstances`, instance identity lost with it, `ctx.problems` unreliable above ~170 frames, large reads `interrupted`.
- **Compaction wipes what the agent learned** about the design mid-task.

## Scope

1. Port-mode guidance in the server instructions.
2. `execute` response hints for silent or common failures.
3. A shared tree reader.
4. `overview` tool.
5. `inspect` tool.

Out of scope here: lint, name audit, capture/verify/contact sheet, tokens, code → design.

## 1. Port-mode guidance (server instructions)

Added as a section of the MCP instructions (they survive context compaction):

- When implementing or refactoring UI from a .pen design, the design is the source of truth for structure, order, content, and styling.
- "Update the existing component" means change it until it matches the design; it never means keep what is there. Rebuild the app shell, navigation or a component when its structure differs.
- Before editing code, call `overview` and `inspect` for the target screen(s), list the structural differences between the design and the current UI (shell, navigation, section order, missing/extra elements), and work through that list.
- If project rules conflict with matching the design (e.g. "preserve the theme"), ask the user once which wins, and follow the answer.
- Never port from screenshots or memory; read the design with `inspect`. Save the spec with `savePath` and re-read it after compaction.

## 2. `execute` hints

The snippet is never rewritten. After the call, the response text is inspected and a `HINT:` line is appended when:

| Condition | Hint |
|---|---|
| error mentions `'console' is not defined` | use `Print(...)`; `console` does not exist in the sandbox |
| error is a SyntaxError and the snippet contains `await` | snippets are synchronous; remove `await` |
| error mentions `must be a non-empty array` and snippet calls `TakeScreenshot`/`Export` | pass an array of ids, e.g. `TakeScreenshot(["id"])` |
| success, but nothing printed, created, exported or screenshotted | nothing was printed; a last expression is not returned, use `Print(...)` |
| error `interrupted` | the snippet ran too long; split it or read with `inspect` |

## 3. Tree reader (`src/design/read.js`, `src/design/snippets.js`)

Reads a subtree of one document with read-only `execute` calls (no save), through the existing routing (headless or app).

Per node: `id` (resolved path for instance content), `parent`, `depth`, `type`, `name`, `enabled`, absolute bounds relative to the screen (`x,y,w,h`, summed from parent-relative `ctx.bounds`), raw sizing (`width`/`height` as number, `fill_container`, `fit_content`), layout (`layout`, `gap`, `padding`, `justifyContent`, `alignItems`, `layoutPosition`, `clip`), style raw and resolved (`fill`, `stroke`, `strokeWidth`, `cornerRadius`, `effect`, `opacity`), text (`content`, `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `textAlign`, `textGrowth`), icon (`library`, `icon`), `theme`, `reusable`, and for instances the component (`ref` id and name) and override keys.

Passes, joined by id:

1. **Raw refs** over the whole document, without resolving: every `ref` node's `ref` and `descendants` keys; every reusable node's name.
2. **Tree** of the target with `resolveInstances: true`: structure, bounds, raw props (variables as `$name`).
3. **Values** of the target with `resolveInstances` and `resolveVariables`: resolved colors and numbers, in each node's own theme context.

An instance appears in pass 2 as a plain frame; its component is taken from pass 1 by id (for content inside instances, by the last path segment).

Limits and failures:

- `maxNodes` (default 4,000) caps a read; the result says how many nodes were left out.
- On `interrupted`, the read splits: the root alone, then each child subtree in its own call, recursively.
- Clipping is computed from absolute bounds against the nearest `clip: true` ancestor (partially / fully clipped), and the engine's `ctx.problems` is kept alongside.
- Variables come from `GetVariables()` once per call: each token's value in every theme.

## 4. `overview(filePath, { focus?, refresh? })`

Big picture of one document. Cached per file by mtime (`refresh: true` bypasses).

Reads root nodes in batches of 50 (split on `interrupted`), without resolving instances.

Sections:

1. **Screens matrix.** Root frames that are not reusable components are parsed into `screen`, `state`, `width`, `theme`:
   - theme: the frame's `theme` property, else a theme word in the name (`day`, `night`, `light`, `dark`, `sáng`, `tối`, `sang`, `toi`);
   - width: a name token that is a known width or `W×H`, else the frame's width;
   - state: a token after ` — `, or an UPPERCASE token, or a known state word (`empty`, `loading`, `error`, `success`, `rỗng`, `lỗi`, `đang tải`, `thành công`, `im lặng`);
   - screen: the rest, with a leading code (`S3`, `M5`) kept and decorations (`★`) dropped.
   Rows are screen + state, columns are widths, each cell lists themes; empty cells are shown. Every row shows the raw frame names; frames whose names cannot be parsed are listed separately. A `.pen-multi.json` next to the .pen can give `screenPattern` (regex with named groups `screen`, `state`, `width`, `theme`) to override parsing.
2. **Bands.** Root frames grouped by vertical position (gap > 400 px starts a band), labelled with the nearest root-level text to the left or above.
3. **Flows.** From root-level `path` nodes outside every frame: the path's first and last points (from `includePathGeometry`) are matched to frames within 80 px; each edge gets the nearest root-level text as its label and a confidence (both ends within 20 px = high). `.pen-multi.json` `flows` (JSON files of `{edges:[{from,to,ev}]}`) are added as declared.
4. **Design system.** Variable count by type and theme axes; components with instance counts and the screens using them; font sizes and gap/padding values in use with counts (values used ≤ 2 times flagged as off-scale); raw hex fills vs variable fills.
5. **Intent.** Text of `note` and `context` nodes, and root-level text that is not a band or row label (first 20).

`focus` (screen code, name or node id) limits the output to one screen row or band with its flows.

Output is text, capped at ~250 lines, with counts for anything cut.

## 5. `inspect(filePath, target, { depth=8, flavor, format="outline", savePath, maxLines=400 })`

- `target`: node id, or a screen name / code. Ambiguous → the candidates are listed, nothing is guessed.
- **Breadcrumb**: the screen's matrix row (other widths, states, themes), band, incoming/outgoing flows, components used with counts.
- **Sections**: the screen's direct children, or the children of its main scroll container (the tallest vertical `fill_container` child), in order; per section the texts (truncated), icons and component instances in reading order. Children docked to the top or bottom (within 4 px, height ≤ 120) or named like a header/nav/tab bar are labelled `shell (inferred)`.
- **Outline**: one line per node: address, type, size and position, sizing mode, layout, style (token name and value per theme), text, component and overrides, clipping. Siblings with the same structure (≥ 3) are collapsed into the first plus `×N` with the fields that differ. Hidden nodes (`enabled: false`) are counted, not listed.
- **Address**: the name path from the screen, `Screen/Section/Row/Title`; `[i]` is added only for duplicate sibling names, with a warning.
- **flavor**: per-node code hints.
  - `tailwind` / `css`: flex direction, gap, padding, alignment, `fill_container` → `flex-1` in a flex parent / `w-full` otherwise, fixed sizes, radius, colors as `var(--token)`, text size, weight, line height.
  - `react-native`: `flexDirection`, `gap`, padding, alignment, `flex: 1` / `alignSelf: 'stretch'`, `lineHeight` in px (= size × ratio), `includeFontPadding: false`, `letterSpacing` in px, shadow → iOS shadow props plus Android `elevation` note, hairline strokes.
- **format**: `outline` (agent-readable), `json` (the full reader output plus breadcrumb and sections), `html-ref` (Pen's `html-css` export with `box-sizing: content-box` rewritten to `border-box` and layer names as `data-pen`, written next to `savePath` or the .pen file).
- **savePath**: writes the JSON form to that path, with the .pen's absolute path, mtime and SHA-1. If a file already exists there with a different SHA-1, the response says the previous spec was stale.
- Output beyond `depth` or `maxLines` is cut with the exact follow-up `inspect` call for the cut subtree.

## Error handling

- Any read failure returns the engine error with the node it was reading.
- A target that is not in the document: error listing the closest names.
- Reads never mark a file dirty and never trigger a save.

## Testing

- Unit (no CLI): name parser against the real root names of the four projects (`test/fixtures/*-roots.json`); matrix building; repeat collapsing; address generation with duplicates; clipping math; flavor hints; html-ref rewrite; execute hints.
- Integration (real CLI, headless): a fixture document built in the test with themed variables (light/dark axis), dark frames via `theme`, a component with overrides and nested instance, repeated rows, a hidden node, duplicate sibling names, a clipped node, a root-level arrow path between two screens with a label, a `note`; `overview` and `inspect` asserted on it.
- Smoke (manual, copies of the four real documents): no crash, output within caps, matrices recognisable (near-me columns 390/768/1280 with sáng/tối).
