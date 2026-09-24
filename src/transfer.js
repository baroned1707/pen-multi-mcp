// Moves nodes between .pen documents with execute snippets: `Get` returns plain node data that
// `Insert` accepts, so a subtree can be read from one document and rebuilt in another.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const snippets = {
  topLevelIds: () => `Print("IDS", JSON.stringify(Get((n, c) => { c.skipChildren(); return n.id; })))`,
  exportNodes: (ids) => `Print("NODES", JSON.stringify(${JSON.stringify(ids)}.map((id) => Get(id))))`,
  deleteNodes: (ids) => `${JSON.stringify(ids)}.forEach((id) => Delete(id))`,
  // A get_app_state-like summary of one document, for app documents that are not the active one
  // (the app's own get_app_state only ever describes the active document).
  documentState: () => `const top = [];
Get((n, c) => { c.skipChildren(); top.push("\`" + n.id + "\` (" + n.type + "): " + (n.name ?? "")); return undefined; });
const comps = [];
Get((n, c) => { if (n.type === "ref") c.skipChildren(); if (n.reusable) comps.push("\`" + n.id + "\`: " + n.name); return undefined; });
const list = (items) => items.length ? items.slice(0, 10).join(", ") + (items.length > 10 ? ", ... +" + (items.length - 10) + " others" : "") : "none";
Print("# Document State\\n\\n## Canvas Editor\\n\\n- Top-level nodes: " + list(top) + "\\n- Reusable components: " + list(comps));`,
  // Rebuilds each subtree node by node, placing every root in free space so nothing overlaps.
  insertNodes: (nodes) => `const ins = (parent, node) => {
  const { children, id, ...props } = node;
  const created = Insert(parent, props);
  for (const child of children || []) ins(created, child);
  return created;
};
const roots = ${JSON.stringify(nodes)}.map((node) => {
  const sized = typeof node.width === "number" && typeof node.height === "number";
  const at = sized ? FindEmptySpace({ width: node.width, height: node.height, padding: 80 }) : null;
  return ins(at?.parentId ?? document, at ? { ...node, x: at.x, y: at.y } : node);
});
Print("NEW", JSON.stringify(roots.map((id) => ({ id, name: Get(id, { depth: 0 }).name }))));`,
};

/** Reads a `<LABEL> <json>` line printed by one of the snippets above. */
export function readPrinted(text, label) {
  const match = new RegExp(`^${label} (.*)$`, "m").exec(text);
  if (!match) throw new Error(`unexpected response, no ${label} line:\n${text.slice(0, 500)}`);
  return JSON.parse(match[1]);
}

const isLocalUrl = (url) => typeof url === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !path.isAbsolute(url);

function eachImageFill(node, fn) {
  for (const fill of [].concat(node.fill ?? [])) if (fill?.type === "image") fn(fill);
  for (const child of node.children ?? []) eachImageFill(child, fn);
}

/**
 * Image fills refer to files next to their document (e.g. a screenshot-to-canvas PNG). Copy those
 * files next to the destination document, renaming on a clash with different content, and point
 * the fills at the copies. Returns new node data; the input is not modified.
 */
export function carryImages(nodes, fromDir, toDir) {
  const copy = structuredClone(nodes);
  const renamed = new Map();
  for (const node of copy) {
    eachImageFill(node, (fill) => {
      if (!isLocalUrl(fill.url)) return;
      if (!renamed.has(fill.url)) renamed.set(fill.url, copyImage(fill.url, fromDir, toDir));
      fill.url = renamed.get(fill.url);
    });
  }
  return copy;
}

function copyImage(url, fromDir, toDir) {
  const src = path.resolve(fromDir, url);
  if (!fs.existsSync(src)) return url;
  const data = fs.readFileSync(src);
  let target = url;
  const dest = () => path.resolve(toDir, target);
  if (fs.existsSync(dest()) && !fs.readFileSync(dest()).equals(data)) {
    const ext = path.extname(url);
    target = `${url.slice(0, url.length - ext.length)}-${createHash("sha1").update(data).digest("hex").slice(0, 8)}${ext}`;
  }
  fs.mkdirSync(path.dirname(dest()), { recursive: true });
  if (!fs.existsSync(dest())) fs.writeFileSync(dest(), data);
  return target;
}
