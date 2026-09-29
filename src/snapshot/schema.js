// The UI snapshot contract, v1: what every source (built-in adapters, `file`, `command`) hands to
// verify, import_ui and sync. Only boxes are required; a source declares in `fields` what else it
// provides, and verify reports what it could not check. Within v1, fields are only added.

export const FIELDS = ["text", "bg", "fg", "fontSize", "fontWeight", "lineHeight", "radius", "border"];

export const SNAPSHOT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "pen-multi://snapshot-schema",
  title: "pen-multi UI snapshot v1",
  type: "object",
  required: ["version", "viewport", "elements"],
  properties: {
    version: { const: 1 },
    platform: { type: "string", description: "Free text: web, android, ios, flutter, desktop…" },
    viewport: {
      type: "object",
      required: ["w", "h"],
      properties: { w: { type: "number", exclusiveMinimum: 0 }, h: { type: "number", exclusiveMinimum: 0 }, scale: { type: "number", description: "Screenshot pixels per unit (default 1)." } },
    },
    screenshot: { type: "string", description: "PNG path of what the elements were read from; pixel regions and close-ups need it." },
    fields: { type: "array", items: { enum: FIELDS }, description: "The element properties this source provides; the others are not compared." },
    pageBg: { type: "string", description: "Background color behind everything (CSS color)." },
    elements: {
      type: "array",
      items: {
        type: "object",
        required: ["box"],
        properties: {
          i: { type: "integer", description: "Index (default: position in the array)." },
          parent: { type: "integer", description: "Index of the enclosing element." },
          box: { type: "object", required: ["x", "y", "w", "h"], properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number", minimum: 0 }, h: { type: "number", minimum: 0 } }, description: "In the design's units (logical px / dp / pt), from the top-left of the screen." },
          text: { type: "string", description: "Text shown by the element itself." },
          marker: { type: "string", description: 'The design node it implements: "pen:<id or address>" or the bare value.' },
          bg: { type: "string" },
          fg: { type: "string", description: "Text or icon color." },
          fontSize: { type: "number" },
          fontWeight: { type: "number" },
          fontFamily: { type: "string" },
          lineHeight: { type: "number", description: "In units, not a ratio." },
          radius: { type: "number" },
          borderWidth: { type: "number" },
          borderColor: { type: "string" },
          icon: { type: "boolean" },
          fixed: { type: "boolean", description: "Pinned to the viewport (a tab bar)." },
          layout: { type: "object", description: "Flex-like layout for import_ui: { dir, gap, padding: [t, r, b, l], align, justify, wrap }." },
        },
      },
    },
  },
};

const TYPES = { number: (v) => typeof v === "number" && Number.isFinite(v), integer: Number.isInteger, string: (v) => typeof v === "string", boolean: (v) => typeof v === "boolean", object: (v) => v && typeof v === "object" && !Array.isArray(v), array: Array.isArray };

/**
 * Checks a snapshot against the schema. Returns [] or up to `max` errors, each naming the path,
 * what was expected, and what was found.
 */
export function validateSnapshot(snap, { max = 8 } = {}) {
  const errors = [];
  const check = (value, schema, at) => {
    if (errors.length >= max) return;
    if (schema.const !== undefined && value !== schema.const) return errors.push(`${at}: must be ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    if (schema.enum && !schema.enum.includes(value)) return errors.push(`${at}: must be one of ${schema.enum.join(", ")}, got ${JSON.stringify(value)}`);
    if (schema.type && !TYPES[schema.type](value)) return errors.push(`${at}: must be ${schema.type === "object" ? "an object" : schema.type === "array" ? "an array" : `a ${schema.type}`}, got ${Array.isArray(value) ? "an array" : value === null ? "null" : typeof value}`);
    if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) return errors.push(`${at}: must be > ${schema.exclusiveMinimum}`);
    if (schema.minimum !== undefined && value < schema.minimum) return errors.push(`${at}: must be ≥ ${schema.minimum}`);
    for (const k of schema.required ?? []) if (value[k] === undefined) errors.push(`${at}.${k}: required${schema.properties?.[k]?.description ? ` (${schema.properties[k].description})` : ""}`);
    if (schema.properties && TYPES.object(value)) for (const [k, s] of Object.entries(schema.properties)) if (value[k] !== undefined) check(value[k], s, `${at}.${k}`);
    if (schema.items && Array.isArray(value)) value.forEach((v, i) => check(v, schema.items, `${at}[${i}]`));
  };
  check(snap, SNAPSHOT_SCHEMA, "snapshot");
  return errors;
}
