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
  const fn = /^(hsla?|oklch|oklab)\(([^)]+)\)$/.exec(s);
  if (fn) return fromFunction(fn[1], fn[2]);
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

const num = (p, scale = 1) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p));
const alphaOf = (p) => (p === undefined ? 1 : p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p));
const angle = (p) => {
  const v = parseFloat(p);
  if (p.endsWith("turn")) return v * 360;
  if (p.endsWith("rad")) return (v * 180) / Math.PI;
  if (p.endsWith("grad")) return v * 0.9;
  return v;
};
const toByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
const gamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** hsl(), oklch() and oklab() in sRGB (out-of-gamut values clipped). */
function fromFunction(kind, body) {
  const parts = body.replace(/,/g, " ").split(/[\s/]+/).filter(Boolean);
  if (parts.length < 3 || parts.some((p) => p === "none")) return null;
  const a = alphaOf(parts[3]);
  if (kind.startsWith("hsl")) {
    const h = ((angle(parts[0]) % 360) + 360) % 360, sat = num(parts[1], 1) / (parts[1].endsWith("%") ? 1 : 100), l = num(parts[2], 1) / (parts[2].endsWith("%") ? 1 : 100);
    const k = (n) => (n + h / 30) % 12;
    const f = (n) => l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return { r: toByte(f(0)), g: toByte(f(8)), b: toByte(f(4)), a };
  }
  let L = num(parts[0], 1), A, B;
  if (kind === "oklch") {
    const C = num(parts[1], 0.4), H = (angle(parts[2]) * Math.PI) / 180;
    A = C * Math.cos(H);
    B = C * Math.sin(H);
  } else {
    A = num(parts[1], 0.4);
    B = num(parts[2], 0.4);
  }
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B, m_ = L - 0.1055613458 * A - 0.0638541728 * B, s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const [l3, m3, s3] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const b = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return { r: toByte(gamma(r)), g: toByte(gamma(g)), b: toByte(gamma(b)), a };
}
