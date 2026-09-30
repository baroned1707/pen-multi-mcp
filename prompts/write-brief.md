# write-brief: the product's intent, for agents that design

Uses the pen-multi MCP tools (`mcp__pen-multi__*`). pen-multi has no model of its own: you write the brief, the user approves it, pen-multi keeps it and says when it goes out of date.

1. `project_context({ filePath })` — where the brief goes (default `design/BRIEF.md`, or `.pen-multi.json` `brief.file`), the design system as it is, and the notes on the canvas.
2. Read the project's own documents: `CLAUDE.md`, the README, and docs about design, brief, brand, UX or components. Skim long files for what a designer needs; do not copy them.
3. Write the brief, under about 8 KB, in the language of the project's documents (ask the user when they are mixed). Sections:
   - **Product** — what it does, for whom, the main jobs.
   - **Language and voice** — UI language, tone, words to use and avoid.
   - **Visual direction** — mood, density, brand cues.
   - **Rules** — do / don't, each pointing at the document it comes from.
   - **Platforms** — widths, themes, input (touch, mouse).
   - **Patterns** — navigation; empty, error and loading states.
   - **Open questions** — what the documents do not settle.
4. Put what the brief states in numbers into a ` ```pen-rules ` block (JSON) under the prose it comes from, so lint checks the design and verify the code. Only numbers the brief's own text states — never values you add from a guideline yourself. Every key is optional; `id` is what findings cite ("R1"); `ignore` takes layer or marker name globs the rule does not apply to:
   ```
   { "type":   { "id": "R1", "sizes": [34, 17, 15, 13], "maxStyles": 4, "exempt": [28], "styleBy": "size", "families": ["Inter"], "ignore": ["TabBar*"] },
     "size":   { "minTarget": 44 },
     "rows":   { "heights": [44, 51], "components": ["Row"] },
     "space":  { "sideMargin": { "0": 16, "720": 20 }, "scale": [4, 8, 16, 20] },
     "action": { "maxProminent": 1, "prominentFills": ["$accent"] },
     "color":  { "tokensOnly": true, "text": ["$fg", "$muted"], "fill": ["$bg", "$panel", "$accent"] } }
   ```
   Paths and skills the brief mentions in backticks are its references: agents are told to read them, and a change to them marks the brief as possibly out of date.
5. Add `"brief": { "file": "<path>", "sources": ["<the documents you used>"] }` to `.pen-multi.json` next to the `.pen`.
6. Show the brief to the user and ask them to approve or correct it.
7. Once approved: `project_context({ filePath, action: "stamp" })` — it records what the brief was written against and puts its outline on the canvas as a note. Commit the brief and `design-sync/brief-stamp.json`.
