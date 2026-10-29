// @ts-check
"use strict";
const { readThreadList, readThreadMetadata } = require("./history-contract.cjs");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { isTaskDraftConfiguration } = require("./task-draft.cjs");

// 只拥有可重建目录的读取批次，沿用项目连接身份和后端关闭屏障。
class CatalogObservation {
  /** @param {import('./history-state.cjs').HistoryHost} host */
  constructor(host) {
    this.host = host;
  }

  /** @param {import('./project-state.cjs').CoreProject} project */
  listThreads(project) {
    return this.scheduleSummaryRead(project, { full: true });
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {string|undefined} threadId */
  refreshThreadSummary(project, threadId) {
    if (!threadId) return this.listThreads(project);
    return this.scheduleSummaryRead(project, { threadId });
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {{full?:boolean,threadId?:string}} options */
  scheduleSummaryRead(project, { full = false, threadId } = {}) {
    const client = project.client;
    if (!client || !this.host.currentConnection(project, client))
      return Promise.resolve(project.summaries);
    const generation = project.connectionGeneration;
    let attempt = project.summaryRead;
    let start = false;
    if (
      !attempt ||
      attempt.client !== client ||
      attempt.generation !== generation ||
      attempt.finished
    ) {
      attempt = { client, generation, pending: null, finished: false };
      project.summaryRead = attempt;
      start = true;
    }
    let batch = attempt.pending;
    if (!batch) {
      // Promise 构造器同步补全回调后才发布，外部不会看见未完成的批次。
      const pending = /** @type {import('./project-state.cjs').SummaryBatch} */ ({
        full: false,
        ids: new Set(),
      });
      pending.promise = new Promise((resolve, reject) =>
        Object.assign(pending, { resolve, reject }),
      );
      attempt.pending = batch = pending;
    }
    if (full || !project.summariesLoaded) {
      batch.full = true;
      batch.ids.clear();
    } else if (!batch.full && threadId) batch.ids.add(threadId);
    attempt.promise = batch.promise;
    // 后端已有读取屏障跟随最新批次，保留原有失败后继续恢复的行为。
    project.summaryReads = batch.promise.catch(() => {});
    if (start) {
      const running = attempt,
        first = batch;
      void Promise.resolve()
        .then(() => this.runSummaryReads(project, running))
        .catch((error) => first.reject(error));
    }
    return batch.promise;
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('./project-state.cjs').SummaryRead} attempt */
  async runSummaryReads(project, attempt) {
    const { client, generation } = attempt;
    const current = () =>
      project.summaryRead === attempt &&
      generation === project.connectionGeneration &&
      this.host.currentConnection(project, client);
    try {
      // 最多一批在途和一批待办；持续通知不能延长已经完成那一批调用方的等待。
      while (current() && attempt.pending) {
        const batch = attempt.pending;
        attempt.pending = null;
        try {
          /** @type {import('@areal/workbench/core-model-contract').CoreThread[]} */
          let data;
          if (batch.full) {
            data = [];
            /** @type {string|null|undefined} */
            let cursor;
            do {
              const classified = client.capabilities?.methods?.includes("areal/conversation/list");
              const page = await client.request(
                classified ? "areal/conversation/list" : "thread/list",
                {
                  limit: 100,
                  ...(classified ? { view: "main", includeArchived: true } : {}),
                  ...(cursor ? { cursor } : {}),
                },
                { decode: readThreadList },
              );
              if (!current()) break;
              data.push(
                ...page.data.filter(
                  (thread) => !isTaskDraftConfiguration(thread.desktop?.configuration),
                ),
              );
              cursor = page.nextCursor;
            } while (cursor);
          } else {
            const ids = [...batch.ids];
            const rows = new Map(project.summaries.map((thread) => [thread.id, thread]));
            for (const id of ids) {
              if (!current()) break;
              let thread;
              try {
                ({ thread } = await client.request(
                  "thread/read",
                  { threadId: id, includeTurns: false },
                  { decode: readThreadMetadata },
                ));
              } catch (error) {
                if (!modelRecord(error) || error.code !== -32004) throw error;
              }
              if (!current()) break;
              if (thread && this.summaryVisible(client, thread)) rows.set(id, thread);
              else rows.delete(id);
            }
            data = [...rows.values()];
            const classified = client.capabilities?.methods?.includes("areal/conversation/list");
            data.sort(
              (a, b) =>
                (classified ? Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0) : 0) ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            );
          }
          if (current()) await this.host.library.recordThreadSummaries(project.id, data);
          if (current()) {
            project.summaries = data;
            project.summariesLoaded = true;
            await this.host.worktrees.observeProject(project);
            if (current()) this.host.onChange();
          }
          batch.resolve(current() ? data : project.summaries);
        } catch (error) {
          batch.reject(error);
        }
      }
    } finally {
      attempt.pending?.resolve(project.summaries);
      attempt.finished = true;
      if (project.summaryRead === attempt) delete project.summaryRead;
    }
  }

  /** @param {import('@areal/runtime-client/core').CoreClient} client @param {import('./history-contract.cjs').HistorySummary} thread */
  summaryVisible(client, thread) {
    if (
      thread.conversation?.kind === "side" ||
      isTaskDraftConfiguration(thread.desktop?.configuration)
    )
      return false;
    if (!client.capabilities?.methods?.includes("areal/conversation/list")) return true;
    return (
      !thread.parentThreadId &&
      !["nativeTaskAgent", "nativeResearchAgent"].includes(String(thread.source))
    );
  }
}

module.exports = { CatalogObservation };
