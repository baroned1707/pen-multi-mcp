// MCP prompts: the design ↔ code workflows as commands every MCP client lists. The texts live in
// prompts/*.md; skills/pen-port/SKILL.md is port-design.md with a skill header (a test keeps
// them identical).
import fs from "node:fs";

const read = (name) => fs.readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8");

export const PROMPTS = {
  "port-design": "Implement a .pen design in the app's code, screen by screen, until every screen verifies as MATCH.",
  "design-from-code": "Bring the .pen design up to what the code shows: import screens that exist only in code, update the others from verify's proposed edits.",
  "sync-check": "Report where design and code stand, screen by screen, and what each side needs.",
};

export function registerPrompts(server, z) {
  for (const [name, description] of Object.entries(PROMPTS)) {
    server.registerPrompt(name, { description, argsSchema: { filePath: z.string().optional().describe("The .pen file."), screen: z.string().optional().describe("Only this screen (name, code or id).") } }, ({ filePath, screen } = {}) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `${read(name)}\n\n${[filePath && `The design: ${filePath}.`, screen && `Only the screen "${screen}".`].filter(Boolean).join(" ")}`.trim() },
        },
      ],
    }));
  }
}
