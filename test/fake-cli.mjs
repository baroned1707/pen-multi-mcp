// Stand-in for `pen interactive` with controllable timing, so pool/shell behaviour can be
// tested deterministically. Mimics the real shell's prompt and output shape.
//   FAKE_STARTUP_MS    delay before the first prompt
//   SLOW:<ms>          in a snippet: answer after <ms>, printing LATE
//   FAKE_SPAWN_LOG     append "<file>" to this path each time an editor starts
//   -a <app> -i <file> app mode: save() touches <file> only if the fake app (FAKE_ACTIVE_FILE)
//                      has it open, yet always prints "Saved", like the real CLI
import fs from "node:fs";
import readline from "node:readline";

const arg = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
const appMode = Boolean(arg("-a"));
const file = arg("-o") ?? arg("-i");
if (process.env.FAKE_SPAWN_LOG) fs.appendFileSync(process.env.FAKE_SPAWN_LOG, `${file}\n`);
const prompt = () => process.stdout.write("\x1b[36mpen\x1b[39m \x1b[2m>\x1b[22m ");

function saveInApp() {
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_ACTIVE_FILE, "utf8"));
  if (state.open.includes(file) && !process.env.FAKE_SAVE_NOOP) {
    const now = new Date(Date.now() + 5); // strictly after the caller's "before" timestamp
    if (fs.existsSync(file)) fs.utimesSync(file, now, now);
    else fs.writeFileSync(file, "saved-by-fake-app");
  }
}

setTimeout(() => {
  process.stdout.write(`[INFO] Ready.\n\npen.dev Interactive Shell\nFile: ${file}\n\n`);
  prompt();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.startsWith("exit(")) process.exit(0);
    const slow = /SLOW:(\d+)/.exec(line);
    const answer = () => {
      if (line.startsWith("save(")) {
        if (appMode) saveInApp();
        else if (!fs.existsSync(file)) fs.writeFileSync(file, "saved-by-fake-cli");
        process.stdout.write(`Saved ${file}\n\n`);
      } else process.stdout.write(`OK\n\n## Print output\n${slow ? "LATE" : "ECHO"} ${file} ${line}\n\n`);
      prompt();
    };
    if (slow) setTimeout(answer, Number(slow[1]));
    else answer();
  });
}, Number(process.env.FAKE_STARTUP_MS ?? 0));
