# Responsive widths and interaction states

Status: approved 2026-09-30. Target release 1.9.0.

## Why

A port is judged per screen × width × theme, one verify call at a time, and only at the widths the
design draws. Real layouts break between those widths (a row that overflows at 600 px, a label cut
at 1000 px), and hover, focus and pressed looks are never checked even when the design draws them.
Designs also rarely draw those states, so developers guess. Three parts, all generic (any web app,
any .pen):

## A. Responsive

1. `verify({ matrix: true })`: every frame of the target's screen row (each width × theme) in one
   call. Each frame is verified as a normal verify (its own report, sync record and Next); the
   result is a table — frame, width, theme, verdict, worst finding — followed by the full report of
   the worst frame only. Close-ups only for that frame.
2. `verify({ between: true })` (web sources): the page is also captured at the midpoint of each pair
   of neighbouring design widths (390/834 → 612). No design exists there, so the checks need none:
   - horizontal overflow: the page scrolls sideways; the outermost elements past the right edge
     (outside any clipping or scrolling container) are named;
   - text cut: a text element whose content overflows a hidden-overflow box (no ellipsis), or is
     cut by ellipsis or line clamp;
   - overlapping text: two text boxes that cover each other (not overlays: fixed, sticky, absolute);
   - touch targets under 24×24 (WCAG 2.5.8) below 1024 px (touch devices), for buttons, links outside text, inputs;
   - structure: the texts of the nearest design frame that the page no longer shows.
   Findings are listed per width; the verdict of the between checks is OK or PROBLEMS.
   Other source kinds: skipped with a note (they cannot capture at an arbitrary width).

## B. Interaction states (when the design has them)

1. New web steps: `{ hover: selector }`, `{ focus: selector }`, `{ down: selector }` (mouse held
   down: pressed). Interaction steps run after the page is fully loaded, scrolled through and its
   fonts settled, right before the capture — so the look they cause is what is measured.
2. `source.element` (web): a CSS selector (`[data-pen="…"]` for a marker). The capture is cut to
   that element: its elements, moved to the element's origin, and its screenshot region. The
   target is then any node — typically a component or a component state frame ("Button — hover") —
   and verify compares the element with it. The viewport width comes from `source.width` (default
   1280).
3. State frames are recognised by name: "Button — hover", "Button / hover", "Button · focus",
   "Button/State=Pressed". When the target is such a frame, `source.element` is set and the steps
   do not already hover, focus or press, verify adds the step for the element (hover → hover,
   focus/focused → focus, pressed/active → down).

## C. Missing states (lint rule `states`)

1. Interactive components (by name: button, input, field, tab, chip, switch, toggle, checkbox,
   radio, select, dropdown, link, …) grouped with their state variants by name. Missing expected
   states → one low finding per component. Expected: hover, focus, disabled when the document has
   a frame ≥ 768 px wide; pressed, disabled otherwise; inputs also expect error.
2. Screens that show repeated content (≥ 3 siblings that are instances of the same component or
   share one structure) without empty, error or loading state frames → one low finding per screen,
   listing the missing states. Only the screens lint checked.

## Out of scope

Native and React Native between-width checks; animating or timing states; generating the missing
state designs.

## Tests

Pure: responsive checks on snapshot fixtures, state-name parsing, step placement, snapshot crop,
lint states on analysis fixtures. Integration: a fixture page with a 612 px overflow, a cut label,
a hover colour, verified per element against a component frame. Each fix mutation-checked.
