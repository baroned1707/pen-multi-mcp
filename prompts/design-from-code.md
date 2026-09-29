# design-from-code: bring the design up to the code

Uses the pen-multi MCP tools (`mcp__pen-multi__*`). The code is the source of truth here; the design follows it.

1. `sync_status({ filePath })` — which screens changed in the code since they last matched, which in the design, and which on both sides. For a screen changed on both sides, stop and ask the user which side wins; show both change lists.
2. A screen that exists only in code: `import_ui({ filePath, source, name })`, then `verify` the new frame (the round trip must be MATCH). Mark the code's components with `data-pen="<component id>"` so they come in as instances.
3. A screen that exists in both: `verify({ filePath, target, source, direction: "code-to-design" })`. Apply the proposed edits you agree with using `execute` (nodes gone from the code are hidden, never deleted — delete them yourself only if they are gone for good), then verify again until MATCH.
4. `lint` the frames you changed (`fix: ["names", "tokens"]`) and keep `tokens` in sync with the code's token file.
5. `save`, then report which screens now match and what you left for the user to decide.
