# pen-multi: observability — how the MCP performs in real use

## Problem

pen-multi is evaluated by fixture evals (small n) and a slow-call log (calls over 3 s only). Real sessions answer questions nobody can answer today:

- which tools are slow and why;
- how often calls fail;
- how big the results are in tokens;
- how many verify runs a screen takes to reach MATCH;
- whether agents follow `Next:`;
- how often reminders fire.

## Decisions (recommended defaults, taken without asking; each can change)

1. **One event per tool call**, appended to `~/.pen-multi/events/<YYYY-MM-DD>.jsonl`, shared by every pen-multi process on the machine.
   - On by default; `PEN_MULTI_EVENTS=0` turns it off.
   - Files older than 30 days are deleted.
   - A day's file stops growing at 20 MB, and the report says so.
2. **No content.** An event holds:
   - the tool;
   - the project (folder name + hash) and the .pen (file name + hash);
   - the mode (app / headless);
   - the milliseconds per step (the existing marks) and in total, and other agents' app calls in flight;
   - the outcome (ok / error, with the first line of the error, max 120 characters);
   - text tokens and image tokens of the result;
   - for verify: verdict, counts, direction, frame id, the sync state, and the `Next:` state;
   - reminder notes;
   - the next call suggested (tool and frame id) and whether the previous suggestion in this process was followed (same tool and target).

   It never holds arguments, texts, code or paths beyond names and hashes.
3. **A report for people:** `node bin/pen-multi.js report [--days N] [--project <name>] [--json]`. It shows:
   - calls, errors and p50 / p95 latency per tool, with the step that dominates;
   - result tokens per tool (text, images);
   - verify:
     - runs per frame until MATCH (median, max);
     - frames never reaching MATCH;
     - the most frequent finding kinds;
     - direction use;
     - sync states;
   - `Next:` followed (%);
   - reminder counts;
   - waiting on the pen.dev app.

   The slow-call log and `list_sessions` stay as they are.
4. **The eval reads the same events.** Each eval run's workspace has its own `PEN_MULTI_HOME`, so its events are its own. Results gain per-run MCP metrics: calls per tool, total MCP milliseconds, result tokens and `Next:` followed.

## Tests

- an event per call, with no argument content;
- the off switch;
- retention and the size cap;
- tokens counted for text and images;
- `Next:` followed computed from consecutive calls;
- the report on a prepared events file (percentiles, runs until MATCH, followed rate, JSON form);
- the eval attaches metrics.
