// lint and tokens: design-file quality checks with safe fixes, and design tokens as code.
import fs from "node:fs";
import path from "node:path";
import { buildModel } from "../design/model.js";
import { ReadError, readSubtree } from "../design/read.js";
import { lintScreen, lintVariants, RULES } from "./rules.js";
import { diffTokens, normalizeTokens, renderTokens } from "./tokens.js";

const SEVERITY = { high: 0, medium: 1, low: 2 };
const FIXABLE = { names: "default-name", tokens: "raw-color" };

export function registerLintTools({ tool, z, route, design, executeSnippet, optionalFilePath }) {
  tool(
    "lint",
    `Check a .pen design for what makes it hard to implement faithfully or to use: raw colors where a token exists, text contrast below WCAG AA, touch targets under 44×44 on phone screens, default layer names ("Frame 12"), off-scale font sizes and spacing, hidden or clipped leftovers, near-misaligned and unevenly spaced siblings in free layouts, engine-reported layout problems, and screens missing a theme most screens have. Without target it checks the document's screens (up to maxScreens). fix: ["names", "tokens"] applies the unambiguous fixes (rename default-named layers after their text or component; replace a raw color with the one token that has exactly that value) and reports what it changed.`,
    {
      filePath: optionalFilePath,
      target: z.string().optional().describe("One screen (name, code or node id). Omit for the whole document."),
      rules: z.array(z.enum([...RULES, "variants"])).optional().describe("Only these rules."),
      fix: z.array(z.enum(["names", "tokens"])).optional().describe("Apply these safe fixes."),
      maxScreens: z.number().int().min(1).max(200).optional().describe("Screens checked without target (default 12)."),
      maxLines: z.number().int().min(10).max(2000).optional().describe("Findings listed (default 150)."),
    },
    async ({ filePath: f, target: wanted, rules, fix = [], maxScreens = 12, maxLines = 150 }) => {
      const target = await route(f);
      const run = design.reader(target);
      const { analysis } = await design.analysisOf(target);
      const frames = analysis.matrix.rows.flatMap((r) => Object.values(r.cells).flat());
      let ids;
      if (wanted) ids = [(await design.resolveTarget(target, wanted)).id];
      else ids = frames.slice(0, maxScreens).map((c) => c.id);
      const doc = { rareFontSizes: new Set(analysis.typeScale.offScale), rareSpacing: new Set(analysis.spacing.offScale) };
      const findings = [];
      const names = new Map();
      for (const id of ids) {
        const model = buildModel(await readSubtree(run, id));
        names.set(id, model.root.name ?? id);
        for (const x of lintScreen(model, doc)) findings.push({ ...x, screen: model.root.name ?? id });
      }
      if (!wanted) findings.push(...lintVariants(analysis).map((x) => ({ ...x, screen: x.address })));
      const shown = findings.filter((x) => !rules || rules.includes(x.rule)).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.rule.localeCompare(b.rule));

      // Fixes: one Update per node, applied in batches.
      const applied = [];
      const wanting = new Set(fix.map((k) => FIXABLE[k]));
      const todo = shown.filter((x) => x.fix && wanting.has(x.rule));
      if (todo.length) {
        const byNode = new Map();
        for (const x of todo) byNode.set(x.id, { ...(byNode.get(x.id) ?? {}), ...x.fix.props });
        const entries = [...byNode];
        for (let i = 0; i < entries.length; i += 150) {
          const batch = entries.slice(i, i + 150);
          const input = `const U = ${JSON.stringify(batch)};\nfor (const [id, props] of U) Update(id, props);\nPrint("FIXED", U.length);`;
          const res = await executeSnippet({ filePath: target.mode === "app" ? target.file : target.file, input });
          if (res.isError) throw new ReadError(`applying fixes failed after ${applied.length}: ${res.content.map((c) => c.text).join("\n").slice(0, 400)}`);
          applied.push(...batch.map(([id]) => id));
        }
      }

      const count = (s) => shown.filter((x) => x.severity === s).length;
      const lines = [
        `# lint: ${wanted ? names.get(ids[0]) : `${ids.length} of ${frames.length} screens`}${!wanted && frames.length > ids.length ? ` (raise maxScreens to check the rest)` : ""}`,
        `${shown.length} findings — ${count("high")} high, ${count("medium")} medium, ${count("low")} low${todo.length ? ` · fixed ${applied.length} nodes (${fix.join(", ")})` : ""}`,
      ];
      const byRule = new Map();
      for (const x of shown) byRule.set(x.rule, (byRule.get(x.rule) ?? 0) + 1);
      if (byRule.size) lines.push(`By rule: ${[...byRule].map(([r, n]) => `${r} ${n}`).join(", ")}`);
      const fixable = shown.filter((x) => x.fix && !applied.includes(x.id));
      if (fixable.length) lines.push(`Safe fixes available for ${fixable.length}: pass fix ${JSON.stringify([...new Set(fixable.map((x) => Object.keys(FIXABLE).find((k) => FIXABLE[k] === x.rule)))])}.`);
      lines.push("");
      for (const x of shown.slice(0, maxLines)) lines.push(`- [${x.severity}] ${x.rule} · ${x.screen} · ${x.address} (${x.id}): ${x.message}${applied.includes(x.id) ? " — fixed" : ""}`);
      if (shown.length > maxLines) lines.push(`… ${shown.length - maxLines} more (raise maxLines, or filter with rules).`);
      if (!shown.length) lines.push("No findings.");
      return design.wrap(target, lines);
    },
  );

  tool(
    "tokens",
    "Export the design's variables (colors, numbers, strings, per theme) as code — css (custom properties with a selector per theme and prefers-color-scheme for dark), tailwind (theme.extend pointing at the CSS variables), json (W3C design tokens, one group per theme) or react-native (a typed tokens object per theme) — and/or compare them with a token file in the code to list missing, changed and extra tokens. Keeps code and design on the same values.",
    {
      filePath: optionalFilePath,
      format: z.enum(["css", "tailwind", "json", "react-native"]).optional().describe("Output format (default css)."),
      savePath: z.string().optional().describe("Write the output here (relative to the agent's working directory); refuses to overwrite a file it did not generate."),
      compare: z.string().optional().describe("A code file with tokens (CSS custom properties, or token JSON) to diff against the design."),
    },
    async ({ filePath: f, format = "css", savePath, compare }) => {
      const target = await route(f);
      const res = await design.reader(target)(`const v = GetVariables(); Print("VARS", JSON.stringify({ variables: v.variables || {}, themes: v.themes || {} }));`);
      if (res.error) throw new ReadError(res.error);
      const m = /^VARS (.*)$/m.exec(res.text ?? "");
      if (!m) throw new ReadError(`could not read the variables:\n${String(res.text).slice(0, 300)}`);
      const { variables, themes } = JSON.parse(m[1]);
      const n = normalizeTokens(variables, themes);
      if (!n.tokens.length) return design.wrap(target, ["The document has no variables; define colors, spacing and type as variables first (SetVariables in execute)."]);
      const lines = [`${n.tokens.length} tokens${n.axis ? `, themes ${n.axis}: ${n.themes.join(", ")}` : ""}.`];
      if (compare) {
        const file = path.resolve(process.cwd(), compare);
        if (!fs.existsSync(file)) throw new ReadError(`compare file not found: ${file}`);
        const d = diffTokens(n, fs.readFileSync(file, "utf8"));
        lines.push(
          "",
          `## Compared with ${file}`,
          d.missing.length || d.changed.length || d.extra.length ? `${d.changed.length} changed, ${d.missing.length} missing in code, ${d.extra.length} only in code.` : "In sync.",
          ...d.changed.map((x) => `- changed ${x.name}${x.theme !== "default" ? ` (${x.theme})` : ""}: design ${x.design}, code ${x.code}`),
          ...d.missing.map((x) => `- missing ${x.name}${x.theme !== "default" ? ` (${x.theme})` : ""}: design ${x.design}`),
          ...d.extra.slice(0, 50).map((x) => `- only in code: ${x}`),
        );
      }
      const output = renderTokens(n, format);
      if (savePath) {
        const out = path.resolve(process.cwd(), savePath);
        if (fs.existsSync(out) && !fs.readFileSync(out, "utf8").includes("Generated by pen-multi") && !(format === "json" && /"\$value"/.test(fs.readFileSync(out, "utf8")))) {
          throw new ReadError(`${out} exists and was not generated by tokens; refusing to overwrite it. Use compare to diff it instead.`);
        }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, output);
        lines.push("", `Wrote ${format} tokens to ${out}.`);
      } else if (!compare) lines.push("", output);
      return design.wrap(target, lines);
    },
  );
}
