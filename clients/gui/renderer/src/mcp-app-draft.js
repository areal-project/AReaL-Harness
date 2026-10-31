import { composerDraftStorage } from "./composerDraftStorage.js";
// Unsent MCP content belongs to the same durable key as the ordinary composer text.
const suffix = ":mcpContent";
// 持久 entry.id 跨 JSON.parse 稳定，上传身份还须绑定实际执行会话。
const images = new Map();
export function mcpImageFile(block) {
  if (
    !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) ||
    typeof block.data !== "string" ||
    block.data.length > 12 * 1024 * 1024
  )
    throw new Error("应用图片类型或大小不受支持。");
  const bytes = Uint8Array.from(atob(block.data), (character) => character.charCodeAt(0));
  return new File(
    [bytes],
    typeof block._meta?.["openai/title"] === "string" ? block._meta["openai/title"] : "应用图片",
    { type: block.mimeType },
  );
}
export function mcpDraftImageFiles(key, entries, owner, release) {
  const imageEntries = entries.filter((entry) => entry.block.type === "image");
  if (!imageEntries.length) return [];
  const draft = images.get(key) ?? new Map();
  return imageEntries.map((entry) => {
    const owners = draft.get(entry.id) ?? new Map();
    const existing = owners.get(owner);
    if (existing) return existing.file;
    const file = mcpImageFile(entry.block);
    images.set(key, draft);
    draft.set(entry.id, owners);
    owners.set(owner, { file, release });
    return file;
  });
}
function changed(key) {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
}
export function readMcpDraft(key, storage = composerDraftStorage) {
  const raw = storage.getItem(key + suffix);
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((entry) => typeof entry?.id !== "string" || !entry.block))
    throw Error("应用草稿格式无效，请保留原内容后重试。");
  return value;
}
export function writeMcpDraft(key, entries, storage = composerDraftStorage) {
  const text = JSON.stringify(entries);
  if (text.length > 4 * 1024 * 1024) throw Error("应用附件过大，未更改草稿。");
  if (entries.length) storage.setItem(key + suffix, text);
  else storage.removeItem(key + suffix);
  const draft = images.get(key);
  if (draft) {
    const retained = new Set(entries.map((entry) => entry.id));
    for (const [id, owners] of draft) {
      if (retained.has(id)) continue;
      for (const { file, release } of owners.values()) release([file]);
      draft.delete(id);
    }
    if (!draft.size) images.delete(key);
  }
  changed(key);
}
export function appendMcpDraft(key, blocks, storage = composerDraftStorage) {
  if (
    !Array.isArray(blocks) ||
    blocks.some(
      (block) => !block || !["text", "image", "resource_link", "resource"].includes(block.type),
    )
  )
    throw Error("应用消息包含不支持的内容。");
  const plain = blocks
    .filter((block) => block.type === "text" && !block._meta?.["openai/title"])
    .map((block) => block.text)
    .join("\n");
  const retained = blocks
    .filter((block) => block.type !== "text" || block._meta?.["openai/title"])
    .map((block) => ({ id: globalThis.crypto.randomUUID(), block }));
  const before = storage.getItem(key),
    old = readMcpDraft(key, storage);
  writeMcpDraft(key, [...old, ...retained], storage);
  try {
    if (plain) storage.setItem(key, [before, plain].filter(Boolean).join("\n"));
  } catch (error) {
    writeMcpDraft(key, old, storage);
    throw error;
  }
  changed(key);
}
export function removeMcpDraft(key, id, storage = composerDraftStorage) {
  writeMcpDraft(
    key,
    readMcpDraft(key, storage).filter((entry) => entry.id !== id),
    storage,
  );
}
export function consumeMcpDraft(key, capture, storage = composerDraftStorage) {
  const consumed = new Set(capture.map((entry) => entry.id));
  writeMcpDraft(
    key,
    readMcpDraft(key, storage).filter((entry) => !consumed.has(entry.id)),
    storage,
  );
}
export function clearMcpDraft(key, storage = composerDraftStorage) {
  writeMcpDraft(key, [], storage);
}
