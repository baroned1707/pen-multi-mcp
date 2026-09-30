# refresh-brief: bring the brief up to the project as it is now

Uses the pen-multi MCP tools (`mcp__pen-multi__*`).

1. `project_context({ filePath, detail: "full" })` — the brief and "Since the brief": sources changed, routes, code components and tokens added or removed, commits and files.
2. For each change, read what it touches (the changed source documents, the new screens or components in the code) and update only the sections of the brief it affects, and their ` ```pen-rules ` numbers. Keep the rest as it is.
3. Show the user what you changed and why, and ask them to approve.
4. Once approved: `project_context({ filePath, action: "stamp" })`, and commit the brief and `design-sync/brief-stamp.json`.
