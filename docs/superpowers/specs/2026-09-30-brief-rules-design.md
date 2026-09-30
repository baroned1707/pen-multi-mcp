# Brief rules checked by machine

Status: approved 2026-09-30. Target release 1.10.0.

## Why

A project's guideline (Apple HIG, Material, a house system) lives in its brief as prose. Measured
on trading-agent: the brief digest showed only R1 of R1–R7 and never the `apple-hig` skill it
points to; `.pen-multi.json` listed no sources, so seven commits to that skill left the brief
"nothing structural changed"; and nothing checked "at most four text styles", "rows are 44 or 51",
"side margin 16, 20 from 720" or "one prominent action per view", on the design or in the code. An
agent that forgot a rule was never told. Everything here is generic: pen-multi checks numbers, not
a named guideline.

## 1. Rules in the brief

A ` ```pen-rules ` block (JSON) under the prose it states in numbers; several blocks are merged.
Every key is optional; `id` is what findings cite ("R1: …"); every group takes `ignore` (layer or
marker name globs the rule does not apply to).

| group | keys |
|---|---|
| `type` | `sizes`, `maxStyles`, `exempt` (sizes outside the style count), `styleBy` (`size` default, or `size+weight`), `families` |
| `size` | `minTarget` (every width, not only phones) |
| `rows` | `heights`, `components` (only instances of these are rows: cards and grid cells are not) |
| `space` | `sideMargin` (`{ "0": 16, "720": 20 }`: the entry with the largest width not above the frame's), `scale` (gap/padding) |
| `action` | `maxProminent`, `prominentFills` (which fills make a button prominent; declared, not guessed) |
| `color` | `tokensOnly` (reuses `raw-color`, cited), `text`, `fill` (token globs allowed per role) |

A broken block (not JSON, an unknown group or key, a value of the wrong kind) is reported by
`project_context`, `doctor`, `lint` and `verify`, never ignored; the other blocks still count.
What cannot be put in numbers ("some heroes may use Title 1") stays in the prose.

## 2. On the design: `lint` rule `brief`

Per screen, grouped by check with a count and up to three examples: sizes outside `sizes`, more
than `maxStyles` styles, fonts outside `families` ("Inter Variable" is Inter), targets under
`minTarget`, row instances whose height is not in `heights`, gap/padding outside `scale` (low),
more than `maxProminent` prominent buttons, raw colors and tokens used outside their role.

Side margins are the noisiest check; measured on trading-agent (below) it is measured as:
- each section's leftmost painted content, from the screen's edge or from a shell on its left (a
  sidebar);
- sections side by side (overlapping vertically) are panes, each measured from its own edge;
- sections named as shell (tab bar, nav bar, rail, sidebar; a number may follow: `TabBar5`) that
  are panes or span the content are skipped, as are nav bars inside a pane;
- centered content is not at a margin: a centered column (a dialog, a max-width layout) skips the
  screen, a centered section is skipped;
- reported only when most sections agree it is off (one full-bleed chart is not the margin).

## 3. On the code: `verify`

A "## Brief rules" part of the report, not part of the verdict (MATCH still means "matches the
design"; a correct port must not fail because the design broke a rule). Only what the code chose
itself: an element with no design node, or a value different from its node's. A value the code
shares with the design is the design's problem, reported by lint. Checked: sizes, fonts, style
count, targets, side margin, text and solid background colors that match no token (alpha,
gradients and `ignore` apart). `between` widths have no design, so every broken rule is listed
there (low severity).

## 4. A brief that is whole and current

- The digest keeps bold-labelled rules (`**R1. …**`) and skips code blocks, then adds "Rules
  checked by lint and verify: …" and "References: …" (paths and skills the brief names in
  backticks).
- References become sources automatically; a folder (a skill) is hashed from its files, bounded
  (2000 files, 32 MB).
- Prompts `write-brief` and `refresh-brief` ask for the block, with only numbers the brief's own
  text states.

## 5. Measured

Unit tests for each check, with a mutation check on each branch (all caught). On a clone of
trading-agent with a `pen-rules` block written from its brief (the real repository untouched):
- digest: R1–R7 and the `apple-hig` skill are shown;
- lint `brief` on 200 of 303 screens: 536 findings, R1 196, R2 88, R5 99. Sampled R1/R2 findings
  are real (7 styles for a maximum of 4; sizes 16 and 20 off the scale; rows 52 or 64 tall). R5 was
  first all noise at tablet and desktop widths (sidebars, split panes, nested tab bars, centered
  cards measured as margins); after the rules above, every value left is a real margin (20 at 390
  where 16 is asked, 16 in list panes at 834+ where 20 is asked, 28 and 32 in content columns).
