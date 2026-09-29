// What an agent should do next, from a frame's state. Every tool ends with this one line, so
// verify, inspect, import_ui, sync_status and port never give contradicting advice.

const call = (tool, args) => `${tool}({ ${Object.entries(args).map(([k, v]) => `${k}: ${String(v).startsWith("<") ? v : JSON.stringify(v)}`).join(", ")} })`;

/**
 * state: "inspected" | "never" | "differs" | "match" | "imported" | "design-changed" |
 * "code-changed" | "both-changed" | "diverged" | "in-sync". `id` is the frame; `direction` the verify
 * direction that produced the state; `others` frame ids of the same screen still to check.
 */
export function nextStep({ state, id, direction = "design-to-code", others = [] }) {
  const verify = (extra = {}) => call("verify", { target: id, ...extra });
  switch (state) {
    case "inspected":
      return `Next: implement it in the code, marking elements with the addresses above (data-pen / testID "pen:…"), then ${verify({ source: "<the running app>" })}.`;
    case "never":
      return `Next: ${verify({ source: "<the running app>" })} — nothing has compared this frame with the code yet.`;
    case "differs":
      return direction === "code-to-design"
        ? `Next: apply the proposed edits you agree with (execute), then run verify again with direction "code-to-design".`
        : "Next: fix the high findings first (missing, extra, order), then the medium ones, in the code at the locations given; then run verify again with the same arguments.";
    case "match":
      return others.length ? `Next: this frame is done; verify the screen's other frames too (${others.slice(0, 6).join(", ")}${others.length > 6 ? ", …" : ""}).` : "Next: this frame is done (port done if you use the port queue).";
    case "imported":
      return `Next: ${verify({ source: "<the same source>" })} — the round trip must be MATCH; then name the layers and turn repeated parts into components.`;
    case "design-changed":
      return `Next: bring the code up to the design changes listed, then ${verify({})}.`;
    case "code-changed":
      return `Next: if the design should follow the code, ${verify({ direction: "code-to-design" })}; if the code drifted by mistake, fix the code and ${verify({})}.`;
    case "both-changed":
      return "Next: the same nodes changed on both sides — stop and ask the user which side wins, showing both change lists; do not overwrite either side.";
    case "diverged":
      return `Next: both sides changed, in different places — carry each change to the other side: update the code for the design changes listed, then ${verify({ direction: "code-to-design" })} for the code changes and apply its edits; ask the user only if one change undoes the other.`;
    case "in-sync":
      return "Next: nothing to do for this frame.";
    default:
      return "";
  }
}
