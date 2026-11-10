// @ts-check
"use strict";
const {
  readMediaRequest,
  validateMediaResponse,
} = require("@areal/workbench/desktop-contract/library-media");
const { commandResponseError } = require("@areal/workbench/desktop-contract");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { readObservationResult } = require("./history-contract.cjs");
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {{submit:(project:Project,method:string,params:import('./project-state.cjs').SubmissionParams,options:{requestId?:string})=>Promise<unknown>}} MediaHost */
/** @typedef {{textInput:(text:string)=>Array<{type:string,text:string}>}} InputHost */
/** @typedef {Record<string,unknown> & {type:string}} MessageInput */
const MAX_BYTES = 16 * 1024 * 1024;
/** @param {unknown} body */
function coreDetail(body) {
  const text = String(body ?? "")
    .slice(0, 1000)
    .trim();
  try {
    /** @type {unknown} */
    const value = JSON.parse(text);
    const message =
      modelRecord(value) && modelRecord(value.error) ? value.error.message : undefined;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    /* Core 非 JSON 正文保持原样 */
  }
  return text;
}
/** @param {number} status @param {unknown} body */
function uploadError(status, body) {
  const detail = coreDetail(body);
  if (/unsupported MIME|signature does not match/i.test(detail))
    return new Error(`不支持的附件：${detail}`);
  if (/16777216|16 MiB|must contain 1|quota|budget exhausted/i.test(detail))
    return new Error(`附件超出限制：${detail}`);
  return new Error(`附件上传失败 (${status})：${detail}`);
}
/** @param {Project} project @param {Record<string,unknown>} request @param {MediaHost} backend */
async function executeMediaCommand(project, request, backend) {
  if (typeof request.threadId !== "string") throw new Error("请先打开附件所属会话");
  const thread = project.model.state.threads[request.threadId];
  if (!thread) throw new Error("请先打开附件所属会话");
  if (request.operation === "list") {
    if (!project.client) throw new Error("Core 连接不可用");
    const result = await project.client.request(
      "thread/read",
      { threadId: request.threadId, includeTurns: true },
      { decode: readObservationResult },
    );
    return {
      uploads: result.thread.desktop?.uploads ?? [],
      archived: result.thread.desktop?.archived === true,
    };
  }
  if (request.operation === "release") {
    if (thread.desktop?.archived) throw new Error("归档会话只读，不能释放附件");
    if (typeof request.uri !== "string" || !/^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(request.uri))
      throw new Error("无效附件引用");
    if (request.requestId !== undefined && typeof request.requestId !== "string")
      throw new Error("无效请求标识");
    try {
      return await backend.submit(
        project,
        "areal/blob/release",
        { threadId: request.threadId, uri: request.uri },
        { requestId: request.requestId },
      );
    } catch (error) {
      if (error instanceof Error && "submissionUnknown" in error && error.submissionUnknown) {
        error.message = `附件释放结果待核对；请检查发送状态并刷新上传记录，不会自动重发。${error.message}`;
      }
      throw error;
    }
  }
  const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
  if (!(project.client instanceof HostCoreClient))
    throw new Error("Host Core transport unavailable");
  if (request.operation === "read") {
    if (typeof request.uri !== "string" || !/^areal:\/\/blob\/[a-f0-9]{64}$/.test(request.uri))
      throw new Error("无效附件引用");
    const result = await project.client.blob({
      operation: "read",
      threadId: request.threadId,
      uri: request.uri,
    });
    if (typeof result.base64 !== "string" || typeof result.mime !== "string")
      throw new Error("附件读取回执无效");
    return { bytes: new Uint8Array(Buffer.from(result.base64, "base64")), mime: result.mime };
  }
  if (request.operation !== "upload" || thread.desktop?.archived)
    throw new Error("会话不可上传附件");
  if (
    !(request.bytes instanceof Uint8Array) ||
    !request.bytes.length ||
    request.bytes.length > MAX_BYTES
  )
    throw new Error("附件必须为 1 B–16 MiB");
  if (typeof request.mime !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(request.mime))
    throw new Error("无效附件类型");
  try {
    const receipt = await project.client.blob({
      operation: "upload",
      threadId: request.threadId,
      mime: request.mime,
      base64: Buffer.from(request.bytes).toString("base64"),
    });
    if (
      typeof receipt.uri !== "string" ||
      typeof receipt.mimeType !== "string" ||
      receipt.sizeBytes !== request.bytes.length
    )
      throw new Error("上传回执不完整");
    return receipt;
  } catch (cause) {
    const definite =
      modelRecord(cause) &&
      ["INVALID_PARAMS", "LIMIT_EXCEEDED", "RESOURCE_UNAVAILABLE", "FORBIDDEN"].includes(
        String(cause.code),
      );
    throw Object.assign(
      new Error(
        `附件上传结果待核对：${cause instanceof Error ? cause.message : String(cause)}。不会自动重发。`,
      ),
      { submissionUnknown: !definite },
    );
  }
}
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
/** @param {Project} project @param {Record<string,unknown>} input @param {MediaHost} backend */
async function mediaCommand(project, input, backend) {
  const request = readMediaRequest(input);
  const result = await executeMediaCommand(project, input, backend);
  try {
    validateMediaResponse(request, result);
  } catch (cause) {
    throw commandResponseError("media", input, cause);
  }
  return result;
}
module.exports = { mediaCommand, messageInput };
