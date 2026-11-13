// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const {
  readObservationResult,
  readInheritedHistoryPage,
  readHistoryEntry,
} = require("@areal/workbench/desktop-contract/conversation-history");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const MAX_CONTEXT_BYTES = 16 * 1024 * 1024;

/** @param {import("@areal/runtime-client/core").CoreClient} client @param {import("@areal/workbench/desktop-contract/conversation-history").HistoryThread} thread */
async function inheritedTurns(client, thread) {
  const seed =
    thread.conversation?.kind === "fork"
      ? modelRecord(thread.conversation.historySeed)
        ? thread.conversation.historySeed.snapshotId
        : undefined
      : undefined;
  if (!seed) return [];
  /** @type {Map<string,import("@areal/workbench/desktop-contract/conversation-history").HistoryTurn>} */
  const turns = new Map();
  /** @type {string|undefined} */
  let cursor;
  /** @type {{id:string,json:string}|undefined} */
  let partial;
  let bytes = 0;
  /** @param {import("@areal/workbench/desktop-contract/conversation-history").HistoryEntry} entry */
  const append = (entry) => {
    const turn = turns.get(entry.sourceTurnId) ?? {
      ...entry.turn,
      id: entry.sourceTurnId,
      sourceThreadId: entry.sourceThreadId,
      status: entry.sourceTurnStatus,
      items: [],
    };
    turn.items.push(entry.item);
    turns.set(entry.sourceTurnId, turn);
  };
  for (let pageNumber = 0; pageNumber < 10000; pageNumber++) {
    const page = await client.request(
      "areal/conversation/history",
      {
        threadId: thread.id,
        view: "inherited",
        maxBytes: 65536,
        ...(cursor ? { cursor } : {}),
      },
      { decode: readInheritedHistoryPage },
    );
    if (page.snapshotId !== seed) throw new Error("评价上下文的继承快照已变化");
    bytes += Buffer.byteLength(JSON.stringify(page));
    if (bytes > MAX_CONTEXT_BYTES) throw new Error("完整评价上下文超过 16 MiB，未截断或提交");
    for (const entry of page.data ?? []) {
      if (!entry.fragment) {
        if (partial) throw new Error("继承上下文分片缺失");
        append(entry);
        continue;
      }
      const fragment = entry.fragment;
      if (
        fragment.offsetUtf8 !== Buffer.byteLength(partial?.json ?? "") ||
        (partial && partial.id !== entry.sourceItemId)
      )
        throw new Error("继承上下文分片不连续");
      const json = (partial?.json ?? "") + fragment.text;
      if (Buffer.byteLength(json) > fragment.totalBytes) throw new Error("继承上下文分片超限");
      if (Buffer.byteLength(json) === fragment.totalBytes) {
        append(readHistoryEntry(JSON.parse(json)));
        partial = undefined;
      } else partial = { id: entry.sourceItemId, json };
    }
    if (page.complete) {
      if (partial) throw new Error("继承上下文不完整");
      return [...turns.values()];
    }
    if (!page.nextCursor || page.nextCursor === cursor) throw new Error("继承上下文游标未推进");
    cursor = page.nextCursor;
  }
  throw new Error("继承上下文页数超过上限");
}

/** @param {import("@areal/runtime-client/core").CoreClient} client @param {string} threadId @param {string} turnId @param {string} itemId */
async function freezeContext(client, threadId, turnId, itemId) {
  const { thread } = await client.request(
    "thread/read",
    { threadId, includeTurns: true },
    { decode: readObservationResult },
  );
  if (thread?.id !== threadId || thread.conversation?.kind === "side")
    throw new Error("无法评价此来源");
  const index = thread.turns?.findIndex((turn) => turn.id === turnId) ?? -1;
  const target = thread.turns?.[index];
  if (!target || target.status === "inProgress") throw new Error("请在回复结束后评价");
  const itemIndex = target.items.findIndex(
    (item) => item.id === itemId && item.type === "agentMessage",
  );
  if (itemIndex < 0) throw new Error("被评价的回复不存在");
  const prefix = structuredClone(thread.turns.slice(0, index + 1));
  prefix[index].items = prefix[index].items.slice(0, itemIndex + 1);
  const context = {
    schema_version: "areal.feedback-context/v1",
    origin: "core_history_projection",
    thread_id: threadId,
    through_turn_id: turnId,
    through_item_id: itemId,
    turns: [...(await inheritedTurns(client, thread)), ...prefix],
  };
  if (context.turns.length > 1000) throw new Error("完整评价上下文超过 1000 轮，未截断或提交");
  const raw = JSON.stringify(context);
  if (Buffer.byteLength(raw) > MAX_CONTEXT_BYTES)
    throw new Error("完整评价上下文超过 16 MiB，未截断或提交");
  return { context, contextSha256: createHash("sha256").update(raw).digest("hex") };
}
module.exports = { freezeContext, MAX_CONTEXT_BYTES };
