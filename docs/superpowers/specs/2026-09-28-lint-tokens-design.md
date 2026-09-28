# pen-multi: lint and tokens (design-file quality)

Sub-project 3 of 4 (after speed and verify; next: code → design).

## Problem

A design that is inconsistent cannot be implemented faithfully: raw hex values where tokens exist make code drift from the theme, off-scale sizes turn into one-off CSS, default layer names give `verify` markers nothing to say, low-contrast text and small touch targets ship as bugs, hidden or clipped leftovers get implemented or questioned. And code tokens drift from the design's variables without anyone noticing.

## `lint`

`{ filePath?, target?, rules?, fix?, maxScreens (12), maxLines (150) }`. One screen, or the document's screens in matrix order.

| Rule | Severity | Fix |
|---|---|---|
| `covered` | high: a text more than half under an opaque layer painted after it (a later sibling of it or of an ancestor) — invisible in the design, and pixel comparison skips text areas | — |
| `raw-color` | medium when a token has exactly (or within ΔE 3) that value; low when no token matches; low when it equals a themed token in this theme | exact match to one unthemed token → `$token` |
| `contrast` | WCAG AA (4.5:1, 3:1 for ≥24px or ≥18.66px bold) against the layers below the text; high when 1.5 below; unknown over images, gradients, translucent layers (skipped) | — |
| `touch-target` | medium: tappable-named frames/instances under 44×44 on screens ≤480 wide | — |
| `default-name` | low: "Frame 12", "Rectangle", "Text" (English and Vietnamese) | rename text to its content, a frame with one text to that text, an instance to its component |
| `off-scale` | low: font sizes and odd spacing used ≤2 times in the document | — |
| `hidden-layer` | low: `enabled: false` layers in screens | — |
| `clipped` | medium: text/instances cut by their clipping container, except content past the bottom of a scroll area or the next items of a carousel; low: fully outside (not below the fold) | — |
| `misaligned` / `uneven-spacing` | low: siblings in free layouts 1–3px off, stacks with one gap off by ≤3px | — |
| `engine-problem` | medium: problems pen.dev reports (except clipping, judged above) | — |
| `variants` | low: screens without a theme that at least half the screens have | — |

Inside component instances only the instance is checked (fix the component). Fixes are applied through the same path as `execute` (autosave, cache invalidation), 150 updates per call.

## `tokens`

`{ filePath?, format: css | tailwind | json | react-native, savePath?, compare? }`

- css: `:root` with the default (or light) values, `[data-<axis>="<theme>"]` blocks (plus `.dark` and `prefers-color-scheme` for dark-like themes); numbers in px except unitless names (weight, opacity, line height…).
- tailwind: `theme.extend` groups (colors, spacing, fontSize, fontWeight, borderRadius) pointing at the CSS variables.
- json: W3C design tokens (`$type`, `$value`), one group per theme.
- react-native: a typed `tokens` object per theme.
- compare: reads CSS custom properties (theme from the block selector) or token JSON, and lists changed, missing and code-only tokens; unthemed tokens are compared once.
- savePath refuses to overwrite files it did not generate.

## Calibration on real files

Run on the four project designs, the first version flagged transparent fills as near-white tokens, white text over hero images and gradients as unreadable, and every row below a scroll fold as clipped. After the fixes above the remaining findings were real: 2.8:1 kicker text on the p2p hero, a 99×40 settings button in driver-app, raw white on near-me image labels.
