// Rules a brief states in numbers: ```pen-rules blocks (JSON) in the brief, merged. pen-multi does not
// know the guideline behind them (HIG, Material, a house system); it checks the numbers — lint on
// the design, verify on the code. What cannot be put in numbers stays in the brief's prose.

// Every key a rule group takes; anything else is reported, never silently ignored.
export const RULE_KEYS = {
  type: ["id", "sizes", "maxStyles", "exempt", "styleBy", "families", "ignore"],
  size: ["id", "minTarget", "ignore"],
  rows: ["id", "heights", "components", "ignore"],
  space: ["id", "sideMargin", "scale", "ignore"],
  action: ["id", "maxProminent", "prominentFills", "ignore"],
  color: ["id", "tokensOnly", "text", "fill", "ignore"],
};

const numbers = (v) => Array.isArray(v) && v.every((x) => typeof x === "number");
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const CHECK = {
  sizes: numbers, exempt: numbers, heights: numbers, scale: numbers, maxStyles: Number.isFinite, minTarget: Number.isFinite, maxProminent: Number.isFinite,
  families: strings, ignore: strings, components: strings, prominentFills: strings, text: strings, fill: strings,
  id: (v) => typeof v === "string", tokensOnly: (v) => typeof v === "boolean", styleBy: (v) => v === "size" || v === "size+weight",
  sideMargin: (v) => v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, x]) => Number.isFinite(Number(k)) && typeof x === "number"),
};

/** The brief's ```pen-rules blocks, merged: { rules, errors: [message] }. */
export function parseRules(text) {
  const rules = {};
  const errors = [];
  const blocks = [...String(text ?? "").matchAll(/^```pen-rules[^\n]*\n([\s\S]*?)^```/gm)];
  blocks.forEach((m, k) => {
    const line = String(text).slice(0, m.index).split("\n").length;
    let obj;
    try {
      obj = JSON.parse(m[1]);
    } catch (err) {
      errors.push(`pen-rules block ${k + 1} (line ${line}) is not JSON: ${err.message}`);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return errors.push(`pen-rules block ${k + 1} (line ${line}) must be an object of rule groups.`);
    for (const [group, body] of Object.entries(obj)) {
      if (!RULE_KEYS[group]) {
        errors.push(`pen-rules block ${k + 1}: unknown group "${group}" (known: ${Object.keys(RULE_KEYS).join(", ")}).`);
        continue;
      }
      const clean = {};
      for (const [key, v] of Object.entries(body ?? {})) {
        if (!RULE_KEYS[group].includes(key)) errors.push(`pen-rules ${group}: unknown key "${key}" (known: ${RULE_KEYS[group].join(", ")}).`);
        else if (!CHECK[key](v)) errors.push(`pen-rules ${group}.${key}: ${JSON.stringify(v).slice(0, 60)} is not valid.`);
        else clean[key] = v;
      }
      rules[group] = { ...(rules[group] ?? {}), ...clean };
    }
  });
  return { rules, errors, blocks: blocks.length };
}

/** "R1" or the group's name: how a finding cites the rule it breaks. */
export const cite = (rules, group) => rules[group]?.id ?? `brief ${group}`;

/** A glob ("TabBar*", "$v-*") as a case-insensitive whole-string test. */
export function glob(pattern) {
  const re = new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  return (s) => re.test(String(s ?? ""));
}
export const anyGlob = (patterns = []) => {
  const tests = patterns.map(glob);
  return (s) => tests.some((t) => t(s));
};

/** The one-line summary of what the rules check, for the brief's digest. */
export function rulesLine(rules) {
  const parts = [];
  const t = rules.type, s = rules.size, r = rules.rows, sp = rules.space, a = rules.action, c = rules.color;
  if (t) parts.push(`${cite(rules, "type")} type${t.sizes ? ` sizes ${t.sizes.join("/")}` : ""}${t.maxStyles ? `, ≤ ${t.maxStyles} styles` : ""}${t.families ? `, fonts ${t.families.join("/")}` : ""}`);
  if (s?.minTarget) parts.push(`${cite(rules, "size")} targets ≥ ${s.minTarget}`);
  if (r?.heights) parts.push(`${cite(rules, "rows")} rows ${r.heights.join("/")}${r.components ? ` (${r.components.join(", ")})` : ""}`);
  if (sp) parts.push(`${cite(rules, "space")}${sp.sideMargin ? ` margins ${Object.entries(sp.sideMargin).map(([w, m]) => `${m}${Number(w) ? ` from ${w}` : ""}`).join(", ")}` : ""}${sp.scale ? ` spacing ${sp.scale.join("/")}` : ""}`);
  if (a?.maxProminent !== undefined) parts.push(`${cite(rules, "action")} ≤ ${a.maxProminent} prominent action${a.maxProminent === 1 ? "" : "s"}`);
  if (c) parts.push(`${cite(rules, "color")}${c.tokensOnly ? " tokens only" : ""}${c.text ? `, text ${c.text.join(" ")}` : ""}${c.fill ? `, fills ${c.fill.join(" ")}` : ""}`);
  return parts.join(" · ");
}

/**
 * Paths and skills the brief refers to ("`.claude/skills/apple-hig`", "docs/x.md", "the `apple-hig`
 * skill"), existing ones only: what an agent should read with the brief, and what makes it stale.
 */
export function references(text, exists) {
  const out = new Set();
  const t = String(text ?? "").replace(/^```[\s\S]*?^```/gm, "");
  for (const m of t.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/[),.:;]+$/, "");
    if (/[/.]/.test(p) && !/^https?:/.test(p) && !p.startsWith("$") && exists(p)) out.add(p);
  }
  for (const m of t.matchAll(/(?:^|[\s(])((?:\.?[\w-]+\/)+[\w.-]+\.(?:md|json|txt|pdf))/g)) if (exists(m[1])) out.add(m[1]);
  for (const m of t.matchAll(/`([\w-]+)` skill|skill `([\w-]+)`/g)) {
    const name = m[1] ?? m[2];
    for (const p of [`.claude/skills/${name}`, `skills/${name}`]) if (exists(p)) out.add(p);
  }
  return [...out];
}
