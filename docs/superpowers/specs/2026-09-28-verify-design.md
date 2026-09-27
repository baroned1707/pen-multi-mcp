# pen-multi: verify design ↔ code on every platform

Sub-project 2 of 4 (after speed; next: design-file quality, code → design).

## Problem

Agents port a design, look at a screenshot, and declare it done. In trading-agent they kept the old UI (shell never ported, old sections left in place) and nothing told them. Models are poor at spotting layout differences in images, so the check must produce **text**: which design node is missing, which UI element is extra, what is off by how much.

## Goals

- One comparison core for every platform; per-platform adapters only produce a UI snapshot.
- Findings as a ranked text list naming design nodes (address + id) and UI elements (selector / testID), with expected vs actual values.
- An image contact sheet for humans, never the primary signal.
- Never show a window; never start the user's app or dev server (the agent passes a URL or a running device).

## Tools

### `capture`
`{ source, width?, height?, colorScheme?, savePath? }` → writes a UI snapshot (JSON) and screenshot (PNG) under `design-verify/captures/` (or `savePath`) and summarizes it (element count, markers found, platform). Standalone so later work (code → design) can reuse it.

### `verify`
`{ filePath?, target, width?, theme?, source? | snapshot?, tolerance?, maxLines? }`
- `target` resolves like `inspect` (id, name, screen code). `width`/`theme` pick the matching cell of the same screen row when the target is a screen (e.g. target "Home", width 390, theme "dark").
- `source` captures now; `snapshot` reuses a capture file.
- Writes `design-verify/<screen-slug>[-<width>][-<theme>].json` (full report) and `.png` (contact sheet) next to the agent's working directory, and returns the text report.

### `contact_sheet`
`{ reports: [path, ...], savePath? }` → one PNG with a row per report: design | UI | UI with numbered issue boxes. Returned inline (downscaled to ≤1600 px wide) and as a file.

### `source` shapes

| kind | fields | snapshot from | fidelity |
|---|---|---|---|
| `web` | `url`, `steps?` (`click`, `fill`, `press`, `wait`, `waitFor`, `eval`), `fullPage?` (default true) | headless Chromium via `playwright-core`: DOM + computed style | boxes, text, colors, typography, radius, borders, markers |
| `probe` | `platform: ios\|android`, `device?`, `deepLink?`, `timeoutMs?` | `pen-probe` inside a dev build of a React Native / Expo app | boxes, text, colors, typography, radius, borders, testIDs |
| `native` | `platform: ios\|android`, `device?`, `deepLink?` | Android: `adb uiautomator dump`; iOS: `maestro hierarchy`; colors sampled from the screenshot | boxes, text, ids; sampled colors |
| `image` | `path`, `width` (logical width of the screenshot) | the PNG only | pixel regions only |

Browser: Playwright's own Chromium if installed, else Chrome (`channel: "chrome"`), else `PEN_MULTI_BROWSER` path; always headless. Viewport = design frame width × (`height` or frame height, capped at 1080), `colorScheme` from the theme name when it is light/dark-like.

## UI snapshot

```
{ version: 1, platform, source, capturedAt, url?, device?,
  viewport: { w, h, scale }, colorScheme?, screenshot: "<png path>",
  elements: [{ i, parent?, tag?, selector?, marker?, text?, box: { x, y, w, h },
               bg?, fg?, fontSize?, fontWeight?, lineHeight?, radius?,
               borderColor?, borderWidth?, opacity? }] }
```

Coordinates are logical (CSS px / dp / pt) from the top-left of the content. Absent fields are unknown and never compared.

## Design side

`readSubtree` + `buildModel` of the chosen frame (values already resolved in the frame's theme), `sections()` for section order, and a PNG export (`Export([id], "png", dir)`, which writes `<dir>/<id>.png`).

Compared design nodes: visible, not fully clipped, non-zero, not note/prompt/context, and one of: text; component instance; icon; frame/rectangle/ellipse with a visible fill or stroke; section or shell node. Descendants of instances are compared only if they are text.

## Matching (design node ↔ UI element)

1. **Marker** (confidence high): `data-pen` (web), `testID`/`nativeID` starting with `pen:` (probe), resource-id / content-desc / accessibility id starting with `pen:` (native); the value (prefix removed) is a node id, a full address (`Home · light/Header/Title`), an address suffix (`Header/Title`), or a unique name.
2. **Text** (medium): normalized text (NFKC, collapsed whitespace, case-insensitive) equal on both sides; several candidates → nearest by position.
3. **Content** (medium): a container whose texts were matched maps to the UI element enclosing them (their common ancestor whose area is closest, within ×0.5–2), innermost containers first.
4. **Geometry** (low): remaining boxes/instances/sections to unmatched UI elements with IoU ≥ 0.6, best first.

UI coordinates are not scaled: CSS px, dp and pt are the design's unit, so fixed sizes (font size, padding) stay comparable. When the device is wider or narrower than the frame, an element passes horizontally if its left, right or center anchor is within tolerance, and its width if both margins are (a stretched fill element).

Refinements from running against real apps (trading-agent web, an Android emulator, an Expo SDK 57 app):
- Positions are relative to the nearest matched ancestor, so a moved section is one finding, not one per child.
- A missing container reports its missing contents in one finding; an unpainted grouping frame whose contents are all present is low ("no element groups …").
- More than 8 extra texts are summarized in one finding (usually a wrong route/state or a whole old screen).
- Phone chrome drawn in mockups (status bar, home indicator) is skipped, and so is the device's own status bar band (probe inset) in the pixel comparison.
- Pixel regions already explained by an element finding (on the design node, or where the UI moved it) are counted, not listed.
- Web capture: scrolls through the page first, walks open shadow roots, clips only by ancestors that contain the box (body overflow propagated to the viewport, absolute/fixed escape), inline paragraphs are one text unless a descendant carries a marker, non-text inputs contribute no text, icon-font ligatures are dropped, ellipsis/line-clamp truncation is a finding.
- Section order is reading order on both sides (layer order can be z-order); fixed/sticky bars may match the viewport's bottom instead of the frame's.
- On devices wider than the frame, pixels of matched leaf nodes without findings are ignored (never sections/shells, never content-matched containers).
- The Android status-bar offset is chosen by comparing element backgrounds with the screenshot at both candidate offsets.
- pen-probe boxes from edge-to-edge windows (negative root y) are shifted to screen coordinates; Fabric views without a public instance are measured through nativeFabricUIManager / UIManager.

## Findings

| Finding | Severity |
|---|---|
| design node without a match (text, instance, section, shell) | high |
| UI text without a design counterpart (old UI left in place) | high |
| section order differs | high |
| text content differs (matched by marker or geometry) | high |
| size off by > 20 % | high |
| position / size beyond tolerance | medium |
| fill / text color ΔE76 > tolerance | medium |
| font size / weight differs | medium |
| line height, radius, border, letter case | low |
| pixel region differs (images, icons, anything unmatched) | medium, or low when inside a node that already has a finding |

Default tolerance: position 4 px, size max(4 px, 5 %), color ΔE 10, font size 1 px, weight 100, line height 2 px, radius 2 px. Text boxes compare left/top only (line boxes differ by platform) and width only for fixed-width text.

Pixel regions: the UI screenshot is scaled to the design width, both are compared in 8 px cells (mean ΔE > 12 flags a cell), flagged cells merge into regions, and each region names the smallest design nodes covering it.

**Verdict**: `match` when no high or medium findings; score = compared design nodes matched with no finding / compared design nodes.

## Report text

Header (screen, source, viewport, theme), verdict and counts (matched by marker / text / geometry), what the source could not compare, then findings numbered and grouped (Structure, Layout, Color, Typography, Visual), each with the design address + id, expected vs actual, and the UI locator. Ends with: files written, markers to add for low-confidence matches, and "fix high first, then re-run verify". Capped at `maxLines` (default 120); the JSON report has everything.

## pen-probe (React Native / Expo)

`probe/react-native/PenProbe.js`, copied or installed into the app, rendered once at the root: `<PenProbe>{app}</PenProbe>`. It does nothing unless `__DEV__`.

- Polls `http://<host>:<port>/pen-probe/next` every 1.5 s (`host` default `localhost`, `port` 7357); a pending request answers `{ id }`.
- Walks the React fiber tree below itself (host components: `tag` 5, host text: 6), measures host instances with `measureInWindow` (Paper and Fabric), flattens `style`, collects `testID`/`nativeID`, text, colors, typography, radius, borders; POSTs `{ id, window, elements }` to `/pen-probe/snapshot`.
- pen-multi opens that port only during a probe capture, under a machine-wide lock so agents take turns. Android runs `adb reverse tcp:<port> tcp:<port>` first. The screenshot comes from `xcrun simctl io <device> screenshot` / `adb exec-out screencap -p`.

## Native adapters

- Android: `adb [-s device] shell uiautomator dump /sdcard/pen-ui.xml`, `adb exec-out cat` it, parse `bounds`, `text`, `resource-id`, `content-desc`, `class`; px → dp with `wm density`.
- iOS simulator: `maestro --device <id> hierarchy` (JSON), `xcrun simctl io <id> screenshot`; points → the screenshot's pixels by width ratio.
- Colors: the dominant color inside each element's box is `bg`; for text, the most frequent color far from `bg` is `fg`.
- `deepLink` opens first: `xcrun simctl openurl` / `adb shell am start -a android.intent.action.VIEW -d`.
- Binaries overridable (`PEN_MULTI_ADB`, `PEN_MULTI_XCRUN`, `PEN_MULTI_MAESTRO`) for tests and odd installs.

## Agent guidance (server instructions)

A port is done only when `verify` reports no high or medium findings for each implemented screen × width × theme. Add `data-pen` / `testID="pen:…"` markers (the address `inspect` prints) to sections, instances and texts while implementing.

## Testing

- Unit: colors/ΔE, PNG helpers, matching, comparison and tolerances, report, pixel regions (synthetic PNGs), uiautomator XML and maestro JSON parsers, probe fiber walker (fake fibers, Paper and Fabric shapes), probe broker (fake HTTP probe), adapters with fake `adb`/`xcrun`/`maestro` scripts.
- Integration (real CLI + headless Chromium): a design built with `execute`; a faithful HTML page → verdict `match`; a drifted page (old banner kept, tab bar missing, sections swapped, wrong color, wrong font size) → exactly those findings; contact sheet is a valid PNG.

## Out of scope

Starting apps/dev servers/simulators; interaction flows beyond `steps`/`deepLink`; Flutter-specific probe (Flutter uses `native`); auto-fixing code.
