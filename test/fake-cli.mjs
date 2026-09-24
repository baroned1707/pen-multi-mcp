// Stand-in for `pen interactive` with controllable timing, so pool/shell behaviour can be
// tested deterministically. Mimics the real shell's prompt and output shape.
//   FAKE_STARTUP_MS  delay before the first prompt
//   a snippet containing SLOW:<ms> answers after <ms>, printing LATE
import readline from "node:readline";

const out = process.argv[process.argv.indexOf("-o") + 1];
const prompt = () => process.stdout.write("\x1b[36mpen\x1b[39m \x1b[2m>\x1b[22m ");

setTimeout(() => {
  process.stdout.write(`[INFO] Ready.\n\npen.dev Interactive Shell\nFile: ${out}\n\n`);
  prompt();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.startsWith("exit(")) process.exit(0);
    const slow = /SLOW:(\d+)/.exec(line);
    const answer = () => {
      if (line.startsWith("save(")) process.stdout.write(`Saved ${out}\n\n`);
      else process.stdout.write(`OK\n\n## Print output\n${slow ? "LATE" : "ECHO"} ${out} ${line}\n\n`);
      prompt();
    };
    if (slow) setTimeout(answer, Number(slow[1]));
    else answer();
  });
}, Number(process.env.FAKE_STARTUP_MS ?? 0));
