# pen-multi: import_ui that looks drawn, not dumped

## Why

Code → design scores 8.0. import_ui still leaves:

- icons as screenshot crops;
- layer names as CSS selectors;
- grids and wrapping rows as absolute boxes;
- repeated cards as loose copies.

A designer has to redo each of these by hand.

## 1. Real icons

The web capture records icon hints on svg and icon-font elements, as `iconHint: { names: [...], library? }`:

- class names (`lucide-search`, `fa-bell`, `material-icons` plus a ligature text, `i-lucide-…`);
- `data-lucide`, `data-icon`;
- `aria-label`;
- `<use href="#name">`.

import_ui turns them into `{ type: "icon", library, icon, fill }`. The library comes from the hint prefix, else the document's most used icon library; the name is normalized (prefixes stripped, kebab-case).

The icon is inserted with a fallback to the crop: when the engine rejects the name, the crop is inserted instead, so a batch never fails on a guess.

The result reports:

- `N icons as icon nodes (library), M kept as crops (no name)`.

## 2. Layer names from the code

The web capture records `name` hints, and the layer name takes the first that exists, in this order:

1. the marker;
2. the React component whose root element this is (from the element's fiber, as pen-probe reads them);
3. `aria-label`;
4. `id`;
5. the first class that reads as a name (not utility-like: no `:`, not only 1–2 letters, not a `px-2`/`mt-4` pattern);
6. the text;
7. the selector (the last resort, as today).

## 3. Grids and wrapping rows

The capture records a grid container's column and row gaps and its column count. A flex container with `wrap` is handled the same way.

- **One column**: a vertical auto layout with the row gap.
- **Several columns, or wrapping**:
  1. children are grouped into rows by their top edge (±2 px);
  2. each row becomes a horizontal frame with the column gap;
  3. the container becomes a vertical auto layout of rows with the row gap.

The 2 px check still applies per frame. Rows and containers that the engine does not reproduce go back to absolute placement, as before.

## 4. Components from repeated structures (opt-in)

`import_ui({ components: true })` turns runs of three or more siblings with the same structure into one component:

- the first occurrence is made `reusable`;
- the others become instances of it, with their texts as overrides (matched in order).

It is off by default: it changes the document's component set, which the user should choose.

The result names the components made.

## Measurement

- **Tests:**
  - icon hints for lucide, font-awesome and material classes;
  - fallback to the crop on an unknown name;
  - name priority;
  - grid of three columns, wrap and single column → rows and auto layout, round trip MATCH;
  - components option → reusable + instances with overrides, round trip MATCH.
- **Real app:** import a trading-agent screen and report icons, names that are not selectors, auto-layout frames, and round-trip MATCH before and after.
