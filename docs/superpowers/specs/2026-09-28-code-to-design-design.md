# pen-multi: code → design (import_ui, sync_status, routes)

Sub-project 4 of 4.

## Problem

Design and code drift in both directions. Screens get built in code first (or change there) and never reach the design; nobody knows which screens were ever checked against the code, or whether a check is still valid after the design changed; `verify` needs a URL per screen that agents have to rediscover every time.

## `import_ui`

`{ filePath?, source | snapshot, name?, width?, height?, colorScheme?, images (true), theme? }`

1. Capture the running screen (same sources as `verify`: web, probe, native).
2. Keep what is visible: painted elements (background, border) become frames with fill, radius and stroke; texts become fixed-width text nodes (content, size, weight, family, color, line height, alignment) at the drawn line's top; images, SVGs, canvases and icons become image fills cropped from the screenshot into `images/` next to the .pen. Elements that paint nothing are dropped and their children re-parented, so the tree is only as deep as what shows.
3. A painted element with its own text (a button) becomes a frame with a centered text inside; one UI element can therefore stand for two design nodes, which `verify` matching allows (a text role and a box role).
4. Colors equal to a document token (ΔE < 1, same alpha, in the chosen theme) are written as the token.
5. The frame is placed 200 px right of the existing content, absolutely laid out; the report says what to do next (auto layout, names, components, lint).

Round trip: importing a page and verifying the new frame against the same page gives MATCH (tested).

## Routes

`.pen-multi.json` next to the .pen: `{ "baseUrl": "http://localhost:5173", "routes": { "<screen name, code or frame name>": "/path" } }`. `verify` with `source: { kind: "web" }` and no `url` resolves the screen's route (absolute routes are used as is). Missing route → an error that shows the JSON to add.

## `sync_status`

Every screen × width × theme from the overview matrix with its route, the latest `verify` report for that frame (reports in `design-verify/` for this .pen), its verdict and age, and whether the .pen changed since (the report stores the .pen's SHA-1). States: `match`, `differs`, `… (stale)`, `never`. Lists up to 8 `verify` calls to run next (routed screens that are never verified, stale or differ).

## Also changed in verify

- Text nodes compare where the line is drawn (the capture records each text element's line box), at the anchor the design text's alignment implies (left edge, center or right edge); fixed-width texts compare their block's width.
- Web capture records font family and text alignment.
- `resolveTarget` falls back to names when an id-like name matches several nodes.
