// `TakeScreenshot` prints a JSON array of {nodeId, image (base64), mimeType}.
// Lift those into MCP image content so the client sees pictures, not base64 text.
const SHOTS = /\[\s*\{\s*"nodeId"[\s\S]*?\}\s*\]/g;

export function toContent(text) {
  const images = [];
  const cleaned = text.replace(SHOTS, (block) => {
    try {
      const shots = JSON.parse(block);
      if (!Array.isArray(shots) || !shots.every((s) => s.image && s.mimeType)) return block;
      for (const s of shots) images.push({ type: "image", data: s.image, mimeType: s.mimeType });
      return `[${shots.length} screenshot(s) attached: ${shots.map((s) => s.nodeId).join(", ")}]`;
    } catch {
      return block;
    }
  });
  return [{ type: "text", text: cleaned || "OK" }, ...images];
}
