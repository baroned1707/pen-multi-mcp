# Changelog

## 1.0.0 — 2026-09-28

Production release: all four parts of the design ↔ code roadmap.

- **Verify design ↔ code** (0.8): `verify`, `capture`, `contact_sheet` for web (headless Chromium), React Native / Expo (`probe/react-native/PenProbe.js`), native Android / iOS (uiautomator / maestro) and screenshots. Findings as text (missing, extra, order, layout, color, typography, pixels), markers, anchors for other device widths, device chrome skipped, modern CSS colors (oklch, hsl, color-mix), shadow DOM, iframes (cross-origin through the browser), scroll-revealed content.
- **Design quality** (0.9): `lint` with safe fixes (names, tokens) and rules for contrast (measured on the render over images and gradients), covered text, touch targets, raw colors, off-scale values, hidden/clipped leftovers, alignment, spacing, variants; `tokens` to CSS / Tailwind / W3C JSON / React Native with a diff against code.
- **Code → design** (0.9): `import_ui` rebuilds a running screen as a frame (round trip verifies as MATCH), `sync_status`, routes in `.pen-multi.json`.
- **Speed** (0.7): pre-warm of the project's design file, one-call `overview`, `npm run bench`.

## 0.6.0

Design context: `overview`, `inspect`, port-mode guidance, execute hints.

## 0.5.0 and earlier

Background, multi-project, multi-agent editing: headless sessions per file, app routing without stealing focus, locks, limits, background saves, workbench browser, full parity with the official server.
