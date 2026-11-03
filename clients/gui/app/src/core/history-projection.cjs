// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @param {import('@areal/workbench/core-model-contract').CoreThread} thread @param {Array<Pick<import('./history-contract.cjs').HistoryEntry,'sourceTurnId'|'sourceItemId'|'turn'|'item'> & {sourceTurnStatus?:string}>} entries */
function mergeHistory(thread, entries) {
  /** @type {Map<string,import('./history-contract.cjs').HistoryTurn>} */
  const turns = new Map();
  for (const entry of entries) {
    const turn = turns.get(entry.sourceTurnId) ?? {
      ...entry.turn,
      id: entry.sourceTurnId,
      status: entry.sourceTurnStatus,
      items: [],
    };
    if (!turn.items.some((item) => item.id === entry.sourceItemId)) turn.items.push(entry.item);
    turns.set(turn.id, turn);
  }
  // 只有页内新出现的轮次排在已显示轮次之前（向上分页）；已显示的轮次保持原顺序，
  // 补全最新一轮时它不会越过已显示的上一轮。
  const shown = new Set((thread.turns ?? []).map((turn) => turn.id));
  const merged = (thread.turns ?? []).map((current) => {
    const older = turns.get(current.id);
    const currentItems = current.items ?? [];
    if (!older) return { ...current, items: currentItems };
    const currentPositions = new Map(currentItems.map((item, index) => [item.id, index]));
    /** @type {import('@areal/workbench/core-model-contract').CoreItem[]} */
    const items = [];
    let position = 0;
    // 重叠条目确定新历史的位置；条目正文及未进入快照的实时尾部沿用当前版本。
    for (const item of older.items) {
      const shared = currentPositions.get(item.id);
      if (shared === undefined) items.push(item);
      else {
        items.push(...currentItems.slice(position, shared + 1));
        position = shared + 1;
      }
    }
    items.push(...currentItems.slice(position));
    return { ...older, ...current, items };
  });
  return {
    ...thread,
    turns: [...[...turns.values()].filter((turn) => !shown.has(turn.id)), ...merged],
  };
}
/** @param {import('./history-state.cjs').HistoryWindow} window */
function historyGaps(window) {
  const cached = new Map(window.pages.map((page) => [page.pageId, page]));
  const gaps = [];
  let beforeItemId = window.baselineFirstItemId;
  for (let index = 0; index < window.pageRecords.length; index++) {
    const record = window.pageRecords[index];
    const page = cached.get(record.id);
    if (page) {
      beforeItemId = page.data[0]?.sourceItemId ?? beforeItemId;
      continue;
    }
    const start = index;
    while (index + 1 < window.pageRecords.length && !cached.has(window.pageRecords[index + 1].id))
      index++;
    gaps.push({
      id: window.pageRecords[index === window.pageRecords.length - 1 ? start : index].id,
      beforeItemId,
      atTop: index === window.pageRecords.length - 1,
      topologyKnown: window.pageRecords
        .slice(start, index + 1)
        .every((record) => record.items.length > 0),
    });
  }
  return gaps;
}

/** @param {import('./history-contract.cjs').HistoryEntry[]} entries */
function pageTopology(entries) {
  return entries.map(({ sourceTurnId: turnId, sourceItemId: itemId, item }) => ({
    turnId,
    itemId,
    type: item.type,
    phase: item.phase,
    activityBreak:
      item.type === "dynamicToolCall" &&
      item.status === "completed" &&
      item.success === true &&
      [
        "agent_spawn",
        "agent_spawn_configured",
        "agent_wait",
        "agent_wait_any",
        "agent_wait_all",
      ].includes(String(item.tool)) &&
      Array.isArray(item.contentItems) &&
      item.contentItems.some((part) => {
        if (!["inputText", "text"].includes(String(part.type))) return false;
        try {
          const value = JSON.parse(String(part.text));
          if (["agent_spawn", "agent_spawn_configured"].includes(String(item.tool)))
            return (
              typeof value?.threadId === "string" &&
              !!value.threadId &&
              !value.threadId.startsWith("workgroup:")
            );
          const reports = Array.isArray(value?.completed) ? value.completed : [value];
          return reports.some(
            (/** @type {Record<string, unknown>|null} */ report) =>
              typeof report?.threadId === "string" &&
              !!report.threadId &&
              report.settled === true &&
              report.timedOut !== true &&
              ["completed", "failed", "interrupted", "cancelled"].includes(String(report.status)),
          );
        } catch {
          return false;
        }
      }),
    visible: item.type !== "agentMessage" || (typeof item.text === "string" && !!item.text.trim()),
    answers:
      item.type === "dynamicToolCall" &&
      item.tool === "ask_user_question" &&
      item.status === "completed" &&
      item.success === true &&
      Array.isArray(item.contentItems) &&
      item.contentItems.some((part) => {
        try {
          const value = JSON.parse(String(part.text));
          const questions = modelRecord(item.arguments) ? item.arguments.questions : undefined;
          return (
            Array.isArray(questions) &&
            questions.length > 0 &&
            questions.every(
              (question) =>
                modelRecord(question) &&
                typeof question.id === "string" &&
                typeof value?.answers?.[question.id] === "string",
            )
          );
        } catch {
          return false;
        }
      }),
  }));
}

module.exports = { mergeHistory, historyGaps, pageTopology };
