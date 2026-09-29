# sync-check: where design and code stand

Uses the pen-multi MCP tools (`mcp__pen-multi__*`).

1. `sync_status({ filePath })` lists every screen × width × theme: in sync, design changed, code changed, both changed, differs, or never verified — each with its next call.
2. Report the table to the user, grouped by what needs doing: code to update (design changed), design to update (code changed), conflicts (both changed — the user decides), and screens never checked.
3. Do not change either side unless the user asks; when they do, follow each row's `Next:`.
