# pen-multi: mutation eval on real apps

## Why

pen-multi's scores (design → code 7.9, code → design 7.2) rest on small-n runs of one fixture page. Improvements need a harness that measures on a real multi-screen app, repeatably, with known answers.

## App descriptors

`bench/eval/apps/<app>.json` describes each app:

```json
{ "repo": "~/Desktop/Workspace/personal/trading-agent", "pen": "trading-agent.pen",
  "app": { "cwd": "ui", "start": "npx vite --port {port} --strictPort --host 127.0.0.1" },
  "link": ["ui/node_modules"], "source": "ui/src" }
```

First app: trading-agent (Vite + React). It has 39 screen frames verified MATCH through `?pen=<fixture>` routes, so it needs no backend. driversafe (Expo) comes later, after pen-multi is set up in that repository.

## Workspace (per run)

1. `git clone --local` the app's committed state into a temp folder. The real repository is never touched.
2. Symlink `link` entries.
3. Rewrite `.pen-multi.json` `baseUrl` to a free port.
4. Start the app and wait until it answers. Stop it after the run.

## Baseline

Verify every routed frame on a pristine workspace and keep the MATCH frames. The result is cached as `bench/eval/apps/.baseline-<app>-<commit>.json`.

## Mutations

Applied to the design with execute and chosen by seed, so a run can be repeated. Each targets a node of a baseline frame that verify compares:

- `text`: change a text's content;
- `color`: change a fill or text color to another color token (or a raw color when the document has none);
- `radius`: change a corner radius;
- `spacing`: change a frame's gap or padding;
- `hide`: hide a node;
- `add`: duplicate a text with new content;
- `order`: swap two siblings in an auto-layout frame.

A task applies 1–3 mutations to one frame.

## Tasks

| Kind | Setup | The agent must | Pass |
|---|---|---|---|
| design-to-code | design mutated; the design is the truth | change the code to the new design | verify MATCH; .pen unchanged; code changed |
| code-to-design | design mutated; the code is the truth | bring the design back to the code | verify MATCH; code unchanged; .pen changed |
| both | design mutated at node A, and a unique text literal of node B replaced in `source`; both committed as "changed since the last match" after a recorded MATCH | carry each change to the other side (diverged) | verify MATCH; both changes present in both |

The prompt names the frame and says which side is the truth (none for both).

## Scoring

Per run:

- pass or fail;
- tokens and turns;
- verify runs;
- wrong-side edits;
- behaviour scores;
- MCP event metrics (1.5.0+).

Per kind: pass rate with n, and medians.

`npm run eval:real -- --app trading-agent [--kinds …] [--n 3] [--servers a,b] [--run]` is a dry run with a cost estimate unless `--run` is given. Results go to `bench/results/real-<app>-<date>.json`.

## Tests

- mutation selection is deterministic per seed and only targets compared nodes;
- each mutation applied and readable back;
- the workspace never writes into the source repo;
- the judge on known pass and fail workspaces (the pristine app passes; a mutated design without a code change fails design-to-code);
- dry run.
