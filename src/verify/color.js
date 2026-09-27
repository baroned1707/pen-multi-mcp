// Color parsing and perceptual distance for comparing design fills with rendered UI colors.

const clamp = (v) => Math.max(0, Math.min(255, v));

/**
 * Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() (comma or space syntax) and "transparent"
 * into { r, g, b, a } (0-255, alpha 0-1), or null for anything else (gradients, named colors).
 */
export function parseColor(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === "object" && "r" in input) return input;
  const s = String(input).trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p) => (p.endsWith("%") ? (parseFloat(p) * 255) / 100 : parseFloat(p));
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const c = { r: clamp(ch(parts[0])), g: clamp(ch(parts[1])), b: clamp(ch(parts[2])), a };
    return [c.r, c.g, c.b, c.a].some(Number.isNaN) ? null : c;
  }
  return null;
}

export const toHex = (c) => {
  if (!c) return null;
  const h = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a * 255) : ""}`.toUpperCase();
};

/** Composites a translucent color over a background (default white). */
export function flatten(c, bg = { r: 255, g: 255, b: 255, a: 1 }) {
  if (!c) return null;
  const a = c.a ?? 1;
  return { r: c.r * a + bg.r * (1 - a), g: c.g * a + bg.g * (1 - a), b: c.b * a + bg.b * (1 - a), a: 1 };
}

function toLab({ r, g, b }) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 ΔE between two colors (translucent ones composited over white). ~2 is barely visible, >10 is clearly different. */
export function deltaE(a, b) {
  const [l1, a1, b1] = toLab(flatten(a));
  const [l2, a2, b2] = toLab(flatten(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
