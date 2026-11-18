// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {{textInput:(text:string)=>Array<{type:string,text:string}>}} InputHost */
/** @typedef {Record<string,unknown> & {type:string}} MessageInput */
/** @param {InputHost} backend @param {Record<string,unknown>} request @returns {MessageInput[]} */
function messageInput(backend, request) {
  const attachments = request.attachments ?? [];
  const media = Array.isArray(attachments)
    ? Array.from(attachments, (/** @type {unknown} */ item) => item)
    : attachments;
  if (!Array.isArray(media) || media.length > 16) throw new Error("每条消息最多 16 个附件");
  /** @type {MessageInput[]} */
  const input =
    typeof request.text === "string" && request.text.trim() ? backend.textInput(request.text) : [];
  const quoteValues = request.conversationQuotes ?? [];
  if (!Array.isArray(quoteValues)) throw new Error("引用超出限制");
  const quotes = quoteValues.map((/** @type {unknown} */ quote) => {
    if (!modelRecord(quote) || typeof quote.text !== "string") throw new Error("引用超出限制");
    return { ...quote, text: quote.text };
  });
  if (
    quotes.length > 8 ||
    quotes.some(
      (quote) =>
        !quote.text.trim() ||
        quote.text.length > 8000 ||
        Object.keys(quote).some((key) => key !== "text"),
    ) ||
    quotes.reduce((total, quote) => total + quote.text.length, 0) > 16000
  )
    throw new Error("引用超出限制");
  if (quotes.length)
    input.push({
      type: "text",
      text:
        "# userselect:\n```userselect\n" +
        JSON.stringify(quotes.map(({ text }) => ({ text }))) +
        "\n```",
    });
  for (const item of media) {
    if (
      !modelRecord(item) ||
      typeof item.type !== "string" ||
      typeof item.url !== "string" ||
      !["image", "audio", "file"].includes(item.type) ||
      !/^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(item.url)
    )
      throw new Error("无效附件");
    input.push(
      item.type === "file"
        ? {
            type: "file",
            url: item.url,
            name: String(item.name ?? "").slice(0, 255),
            mime_type: item.mimeType,
          }
        : { type: item.type, url: item.url },
    );
  }
  if (request.mcpContent !== undefined && !Array.isArray(request.mcpContent))
    throw new Error("MCP 内容必须为数组");
  /** @type {unknown[]} */
  const blocks = [...(request.mcpContent ?? [])];
  for (const item of media)
    if (modelRecord(item) && item._meta !== undefined)
      blocks.push({
        type: "resource_link",
        uri: item.url,
        name: String(item.name ?? item.type).slice(0, 255),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        _meta: item._meta,
      });
  if (blocks.length > 32) throw new Error("MCP 内容最多32项");
  /** @param {unknown} value @returns {unknown} */
  const withoutMeta = (value) =>
    Array.isArray(value)
      ? value.map(withoutMeta)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "_meta")
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, withoutMeta(value)]),
          )
        : value;
  for (const block of blocks) {
    if (!modelRecord(block) || Buffer.byteLength(JSON.stringify(block)) > 65536)
      throw new Error("MCP 内容无效或超过64KiB");
    let text;
    if (block.type === "text" && typeof block.text === "string" && block.text.length)
      text = block.text;
    else if (
      block.type === "resource_link" &&
      typeof block.uri === "string" &&
      typeof block.name === "string"
    )
      text = JSON.stringify(withoutMeta(block));
    else if (
      block.type === "resource" &&
      modelRecord(block.resource) &&
      typeof block.resource.uri === "string" &&
      (typeof block.resource.text === "string" || typeof block.resource.blob === "string")
    )
      text = JSON.stringify(withoutMeta(block));
    else throw new Error("不支持的 MCP 消息内容");
    input.push({ type: "text", text, text_elements: [], mcpContent: block });
  }
  if (!input.length && request.command === undefined) throw new Error("消息不能为空");
  return input;
}
module.exports = { messageInput };
