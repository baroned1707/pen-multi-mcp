#!/usr/bin/env node
// Stand-in for `open -g -a Pen <file>`: the fake app opens the document in a new window,
// which becomes its active one, as the real app does.
import fs from "node:fs";

const [stateFile, file] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
fs.writeFileSync(
  stateFile,
  JSON.stringify({ ...state, active: file, open: [...new Set([...state.open, file])], ready: (state.ready ?? []).filter((f) => f !== file) }),
);
