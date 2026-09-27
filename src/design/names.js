// Screen frame names -> { screen, code, state, width, theme }, and the screen matrix built from them.
// Projects name screens differently ("S3 · Trang tin · sáng", "home · day", "★ M2 Tải file · ĐANG TẢI · 360",
// "Hôm nay — rỗng"); these rules cover the conventions seen so far, and a project can override them
// with a `screenPattern` regex in .pen-multi.json.

const THEME_WORDS = new Set(["day", "night", "light", "dark", "sáng", "tối", "sang", "toi"]);
const STATE_WORDS = new Set([
  "empty", "loading", "error", "success", "disabled", "offline",
  "rỗng", "lỗi", "đang tải", "thành công", "im lặng", "trống",
]);
const KNOWN_WIDTHS = new Set([320, 360, 375, 390, 393, 402, 412, 414, 428, 430, 440, 600, 744, 768, 820, 834, 1024, 1280, 1366, 1440, 1536, 1920]);
const DECORATION = /^[\s★☆•*→#]+/;
const CODE = /^([A-Z]{1,3}\d+[a-z]?)(?=\s|$)/;

const isUpperWord = (t) => t === t.toUpperCase() && t !== t.toLowerCase() && !CODE.test(t);

function widthOf(token, frameWidth) {
  const wh = /^(\d{3,4})\s*[×x]\s*\d{3,4}$/.exec(token);
  if (wh) return Number(wh[1]);
  // "desktop 1280", "tablet 768", "1280px"
  const labelled = /^(?:(?:desktop|tablet|mobile|phone|web|laptop|khổ)\s+)?(\d{3,4})\s*(?:px)?$/i.exec(token);
  if (labelled && labelled[0] !== labelled[1]) return Number(labelled[1]);
  if (/^\d{3,4}$/.test(token)) {
    const n = Number(token);
    if (KNOWN_WIDTHS.has(n) || Math.abs(n - frameWidth) <= 2) return n;
  }
  return null;
}

/** The first value of a frame's `theme` property, e.g. { mode: "toi" } -> "toi". */
const frameTheme = (theme) => (theme && typeof theme === "object" ? (Object.values(theme)[0] ?? null) : null);

export function parseScreenName(name, frame = {}, conventions = {}) {
  const fw = Math.round(frame.width ?? 0);
  if (conventions.screenPattern) {
    const g = new RegExp(conventions.screenPattern).exec(name)?.groups;
    if (g) {
      return {
        code: g.code ?? null,
        screen: g.screen ?? name,
        state: g.state ?? null,
        width: g.width ? Number(g.width) : fw,
        theme: frameTheme(frame.theme) ?? g.theme ?? null,
      };
    }
  }
  const clean = String(name ?? "").replace(DECORATION, "").trim();
  const [head, ...dashParts] = clean.split(/\s+[—–]\s+/);
  const headParts = head.split(/\s*[·•|]\s*/).filter(Boolean);
  const title = [];
  let width = null, theme = null, state = null;
  const classify = (token, fromDash) => {
    const t = token.trim();
    if (!t) return;
    const lower = t.toLowerCase();
    const w = widthOf(t, fw);
    if (THEME_WORDS.has(lower)) theme ??= t;
    else if (w !== null) width ??= w;
    else if (fromDash || STATE_WORDS.has(lower) || (title.length > 0 && isUpperWord(t))) state = state ? `${state} · ${t}` : t;
    else title.push(t);
  };
  headParts.forEach((t) => classify(t, false));
  dashParts.forEach((t) => classify(t, true));
  // "error · day" is a screen called error, not the error state of an unnamed screen.
  if (!title.length && state) [title[0], state] = [state, null];
  const screen = title.join(" · ");
  return {
    code: CODE.exec(title[0] ?? "")?.[1] ?? null,
    screen,
    state,
    width: width ?? fw,
    theme: frameTheme(frame.theme) ?? theme,
  };
}

const ANNOTATION = /^\s*[→←↑↓◇◆▸▶#※]/;

/**
 * Whether a root frame is a screen, rather than a label, flow-arrow caption or section header
 * (p2p draws "→ trang chủ" and "◇ KHÁCH HÀNG" as small frames). Screens are at least phone-sized.
 */
export const isScreenFrame = (f) =>
  !f.reusable && !ANNOTATION.test(f.name ?? "") && (f.width ?? 0) >= 280 && (f.height ?? 0) >= 300;

/**
 * Groups screen frames into rows (screen + state) and columns (width); each cell lists its frames
 * with their theme. Rows keep canvas order. Frames with no recognisable screen are `unparsed`.
 */
export function buildMatrix(frames, conventions = {}) {
  const rows = new Map();
  const unparsed = [];
  const widths = new Set();
  for (const f of frames) {
    const p = parseScreenName(f.name, f, conventions);
    if (!p.screen) {
      unparsed.push(f);
      continue;
    }
    const key = `${p.screen}\u0000${p.state ?? ""}`;
    if (!rows.has(key)) rows.set(key, { screen: p.screen, code: p.code, state: p.state, cells: {} });
    const row = rows.get(key);
    (row.cells[p.width] ??= []).push({ id: f.id, name: f.name, theme: p.theme, height: f.height });
    widths.add(p.width);
  }
  return { rows: [...rows.values()], widths: [...widths].sort((a, b) => a - b), unparsed };
}
