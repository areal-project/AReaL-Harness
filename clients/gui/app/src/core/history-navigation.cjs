// @ts-check
"use strict";
const { pageTopology } = require("./history-projection.cjs");
const { randomUUID } = require("node:crypto");
const {
  readHistoryPage,
  readHistoryFragmentPage,
  readHistoryEntry,
  isDeferredItem,
  historyFailure,
} = require("./history-contract.cjs");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const historyPageBytes = 256 * 1024,
  historyMaxBytes = 1024 * 1024;
const historyItemBytes = 128 * 1024 * 1024;
/** @param {unknown} error */
const historyReason = (error) =>
  modelRecord(error)
    ? (error.reason ?? (modelRecord(error.data) ? error.data.reason : undefined))
    : undefined;

/** @param {InstanceType<typeof import('./history-observation.cjs').HistoryObservation>} observation @param {import('./project-state.cjs').CoreProject} project @param {import('@areal/workbench/desktop-contract').HistoryRequest} request @returns {Promise<unknown>} */
async function historyCommand(observation, project, request) {
  const { threadId, viewId, operation } = request;
  let window = observation.historyWindow(project, threadId);
  if (operation === "release") {
    if (!window) return { released: true };
    const released = window;
    window.views.delete(viewId);
    window.targets.delete(viewId);
    observation.pruneReadingSnapshots(project, window);
    if (!window.views.size) {
      window.epoch++;
      const drop = new Set(
        [...window.pages, ...window.stalePages].flatMap((page) =>
          page.data.map((entry) => entry.sourceItemId),
        ),
      );
      const thread = project.model.state.threads[threadId];
      if (thread)
        project.model.replace({
          ...thread,
          turns: (thread.turns ?? [])
            .map((turn) => ({
              ...turn,
              items: (turn.items ?? [])
                .filter((item) => !drop.has(item.id))
                .map((item) => released.loaded.get(item.id)?.placeholder ?? item),
            }))
            .filter((turn) => turn.items.length || turn.status === "inProgress"),
        });
      window.pages = [];
      window.stalePages = [];
      window.pageRecords = [];
      window.loaded.clear();
      window.loading.clear();
      window.olderRead = null;
      window.latestTurn.read = null;
      window.displayed = undefined;
      window.nextCursor = window.baselineCursor;
      window.complete = window.baselineComplete;
      window.omitted = false;
      observation.publishHistory(project, window);
    }
    return { released: true };
  }
  if (!observation.supportsBoundedHistory(project.client))
    return { supported: false, message: "当前 Core 使用完整历史读取，不支持分页；请更新 Core。" };
  if (!window) {
    await observation.openThread(project, threadId);
    window = observation.historyWindow(project, threadId);
  }
  if (!window) throw historyFailure("历史视图尚未就绪，请重新打开聊天。");
  if (operation === "acquire") {
    const registered = window.views.has(viewId);
    window.views.add(viewId);
    // 新的显式阅读先重建已失效基线；已有 view 的重复注册不能启动恢复循环。
    if (window.invalidated && !registered) {
      await observation.refreshHistory(project, window);
      window = observation.historyWindow(project, threadId);
    }
    if (!window?.views.size) throw historyFailure("历史视图已关闭，请重新打开聊天。");
    const acquiredWindow = window;
    const acquiredEpoch = window.epoch;
    await observation.hydrateLatest(project, window);
    if (
      observation.historyWindow(project, threadId) !== acquiredWindow ||
      window.epoch !== acquiredEpoch ||
      window.invalidated ||
      !window.views.size ||
      !observation.host.currentConnection(project, window.client) ||
      project.connectionGeneration !== window.generation
    )
      throw historyFailure("历史视图已变化，请重新加载。");
    return { supported: true, complete: window.complete };
  }
  if (!window.views.has(viewId)) throw historyFailure("历史视图已关闭，请重新打开聊天。");
  if (operation === "ensureAnchor" && window.invalidated) {
    await observation.refreshHistory(project, window);
    window = observation.historyWindow(project, threadId);
    if (!window?.views.has(viewId)) throw historyFailure("历史视图已关闭，请重新打开聊天。");
  }
  if (operation === "retain" || operation === "ensureAnchor") {
    const previous = window.targets.get(viewId);
    const accepted =
      !previous ||
      request.revision > previous.revision ||
      (request.revision === previous.revision &&
        JSON.stringify(request.anchor) === JSON.stringify(previous.anchor));
    if (accepted && (!previous || request.revision > previous.revision))
      window.targets.set(viewId, { revision: request.revision, anchor: request.anchor });
    if (operation === "retain") {
      if (accepted) observation.pruneReadingSnapshots(project, window);
      return {
        supported: true,
        retained: accepted,
        revision: request.revision,
        viewGeneration: window.viewGeneration,
      };
    }
    if (!accepted)
      return {
        supported: true,
        kind: "cancelled",
        revision: request.revision,
        viewGeneration: window.viewGeneration,
      };
    return observation.ensureAnchor(project, window, viewId, request.revision, request.anchor);
  }
  if (operation === "loadOlder" && window.invalidated) {
    await observation.refreshHistory(project, window);
    window = observation.historyWindow(project, threadId);
    if (!window?.views.has(viewId)) throw historyFailure("历史视图已关闭，请重新打开聊天。");
  }
  const client = project.client,
    epoch = window.epoch;
  if (!client) throw historyFailure("会话连接尚未就绪。");
  const current = () =>
    observation.host.currentConnection(project, client) &&
    observation.historyWindow(project, threadId) === window &&
    window.epoch === epoch &&
    window.views.has(viewId);
  /** @param {string|null} cursor @param {number} [maxBytes] */
  const read = (cursor, maxBytes = historyPageBytes) =>
    client.request(
      "areal/conversation/history",
      { threadId, view: "own", cursor, maxBytes },
      { decode: readHistoryPage, maxResponseBytes: maxBytes },
    );
  if (operation === "loadOlder") {
    await observation.hydrateLatest(project, window);
    if (!current()) throw historyFailure("历史视图已变化，请重新加载。");
    if (window.olderRead) return window.olderRead;
    const oldest = Math.max(
      -1,
      ...window.pages.map((page) =>
        window.pageRecords.findIndex((record) => record.id === page.pageId),
      ),
    );
    const revisit = request.pageId
      ? window.pageRecords.find((record) => record.id === request.pageId)
      : window.pageRecords[oldest + 1];
    if (request.pageId && !revisit) throw historyFailure("历史占位已变化，请重新加载。");
    if (!revisit && !window.nextCursor) return { data: [], complete: true, nextCursor: null };
    const cursor = revisit?.cursor ?? window.nextCursor;
    if (!cursor) throw historyFailure("历史游标不可用，请重新加载。");
    const loading = Promise.resolve().then(async () => {
      try {
        const page = await read(cursor);
        if (!current()) throw historyFailure("历史视图已变化，请重新加载。");
        observation.validateHistoryPage(window, page, cursor);
        const record = {
          id: window.pageRecords.find((record) => record.cursor === cursor)?.id ?? randomUUID(),
          cursor,
          items: pageTopology(page.data),
        };
        if (
          !observation.cacheHistoryPages(
            project,
            window,
            [{ ...page, pageId: record.id }],
            [record],
            cursor,
          )
        )
          throw historyFailure("历史页已被其他阅读视图占用，请释放阅读位置后重试。");
        return page;
      } catch (error) {
        if (current() && historyReason(error) === "HISTORY_CURSOR_STALE")
          await observation.refreshHistory(project, window);
        throw error;
      } finally {
        if (window.olderRead === loading) {
          window.olderRead = null;
          observation.publishHistory(project, window);
        }
      }
    });
    window.olderRead = loading;
    observation.publishHistory(project, window);
    return loading;
  }
  if (operation !== "loadItem") throw historyFailure("不支持的历史读取操作。");
  const placeholder = project.model.state.threads[threadId]?.turns
    ?.flatMap((turn) => turn.items ?? [])
    .find((item) => item.id === request.itemId);
  if (!isDeferredItem(placeholder)) return { loaded: true, itemId: request.itemId };
  if (window.loading.has(placeholder.id)) throw historyFailure("此内容正在加载。");
  let cursor = placeholder.cursor,
    version = /** @type {string|undefined} */ (placeholder.version),
    totalBytes = placeholder.totalBytes,
    offset = 0,
    chunks = [],
    restarted = false;
  const reserved = () =>
    [...observation.historyWindows.values()].reduce(
      (sum, view) =>
        sum +
        [...view.loaded.values()].reduce((n, item) => n + item.bytes, 0) +
        [...view.loading.entries()].reduce(
          (n, [id, item]) => n + (view === window && id === placeholder.id ? 0 : item.totalBytes),
          0,
        ),
      0,
    );
  const reserve = () => {
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 1 ||
      totalBytes + reserved() > historyItemBytes
    )
      throw historyFailure("完整内容超过当前 128 MiB 阅读缓存，请关闭其他已加载内容后重试。");
    window.loading.set(placeholder.id, { bytes: offset, totalBytes });
    observation.publishHistory(project, window);
  };
  reserve();
  try {
    while (true) {
      if (!current()) throw historyFailure("历史视图已关闭或变化。");
      let page;
      try {
        page = await client.request(
          "areal/conversation/history",
          { threadId, view: "own", cursor, maxBytes: historyMaxBytes },
          { decode: readHistoryFragmentPage, maxResponseBytes: historyMaxBytes },
        );
      } catch (error) {
        if (
          historyReason(error) === "HISTORY_ITEM_CHANGED" &&
          modelRecord(error) &&
          modelRecord(error.data) &&
          typeof error.data.restartCursor === "string" &&
          !restarted
        ) {
          cursor = error.data.restartCursor;
          offset = 0;
          chunks = [];
          version = undefined;
          restarted = true;
          continue;
        }
        if (current() && historyReason(error) === "HISTORY_CURSOR_STALE")
          await observation.refreshHistory(project, window);
        throw error;
      }
      if (!current()) throw historyFailure("历史视图已关闭或变化。");
      const entry = page.data?.[0],
        fragment = entry?.fragment;
      if (
        page.data?.length !== 1 ||
        entry.sourceThreadId !== threadId ||
        entry.sourceItemId !== placeholder.id ||
        !fragment ||
        fragment.offsetUtf8 !== offset ||
        typeof fragment.text !== "string" ||
        typeof fragment.version !== "string" ||
        (version !== undefined && fragment.version !== version) ||
        (offset > 0 && fragment.totalBytes !== totalBytes)
      )
        throw historyFailure("历史内容分片不连续或版本已变化。");
      if (version === undefined) {
        version = fragment.version;
        totalBytes = fragment.totalBytes;
      }
      if (fragment.totalBytes !== totalBytes) throw historyFailure("历史内容长度已变化。");
      const bytes = Buffer.from(fragment.text, "utf8");
      offset += bytes.length;
      chunks.push(bytes);
      if (offset > totalBytes) throw historyFailure("历史内容超过声明长度。");
      reserve();
      if (offset === totalBytes) {
        if (!page.complete || page.nextCursor) throw historyFailure("历史内容终点无效。");
        const complete = readHistoryEntry(
          JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")),
        );
        if (
          complete.sourceThreadId !== threadId ||
          complete.sourceItemId !== placeholder.id ||
          complete.item?.id !== placeholder.id
        )
          throw historyFailure("完整历史内容与当前条目不匹配。");
        const thread = project.model.state.threads[threadId];
        const stillDeferred = (thread.turns ?? [])
          .flatMap((turn) => turn.items ?? [])
          .find((item) => item.id === placeholder.id);
        if (
          stillDeferred?.type === "historyDeferred" &&
          stillDeferred.cursor === placeholder.cursor
        ) {
          window.loaded.set(placeholder.id, { placeholder, bytes: totalBytes });
          project.model.replace({
            ...thread,
            turns: (thread.turns ?? []).map((turn) => ({
              ...turn,
              items: (turn.items ?? []).map((item) =>
                item.id === placeholder.id ? complete.item : item,
              ),
            })),
          });
        }
        return { loaded: true, itemId: placeholder.id };
      }
      if (!page.nextCursor || page.nextCursor === cursor || !bytes.length)
        throw historyFailure("历史内容游标未推进。");
      cursor = page.nextCursor;
    }
  } finally {
    window.loading.delete(placeholder.id);
    observation.publishHistory(project, window);
  }
}

module.exports = { historyCommand };
