// @ts-check
"use strict";
const { historyCommand } = require("./history-navigation.cjs");
const { mergeHistory, historyGaps, pageTopology } = require("@areal/workbench/history-projection");
const { randomUUID } = require("node:crypto");
const {
  readObservationResult,
  readHistoryPage,
  isHistoryNotification,
  historyFailure,
} = require("./history-contract.cjs");
const { TaskNotificationMonitor } = require("./notifications.cjs");
const { readTask } = require("@areal/workbench/desktop-contract/management-tasks");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { isTaskDraftConfiguration } = require("./task-draft.cjs");
const { readInspection } = require("./thread-configuration.cjs");
const { CatalogObservation } = require("./catalog-observation.cjs");

// Owns rebuildable history windows and read recovery. It cannot submit mutations.
/** @param {unknown} error */
const isObservationSizeFailure = (error) =>
  modelRecord(error) &&
  error.code === "RESPONSE_TOO_LARGE" &&
  ["thread/read", "areal/thread/observe"].includes(String(error.method)) &&
  error.submissionUnknown === false;
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const historyPageBytes = 256 * 1024,
  historyMaxBytes = 1024 * 1024;
const historyViewLimit = 8,
  historyPageLimit = 16,
  historyTopologyBytes = 64 * 1024;
/** @param {unknown} error */
const historyReason = (error) =>
  modelRecord(error)
    ? (error.reason ?? (modelRecord(error.data) ? error.data.reason : undefined))
    : undefined;
/** @param {unknown} error */
const retryableRead = (error) =>
  modelRecord(error) &&
  ((modelRecord(error.recovery) && error.recovery.kind === "retryRead") ||
    (!error.recovery &&
      ["TIMEOUT", "DISCONNECTED", "CONNECTION_LOST", "RESPONSE_UNKNOWN"].includes(
        String(error.code),
      )));
const observationDelays = [500, 1000, 2000, 4000, 8000];

class HistoryObservation {
  /** @param {import('./history-state.cjs').HistoryHost} host */
  constructor(host) {
    this.host = host;
    this.catalog = new CatalogObservation(host);
    /** @type {Map<string,import('./history-state.cjs').HistoryWindow>} */
    this.historyWindows = new Map();
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('@areal/runtime-client/core').CoreClient} client @param {string} method @param {unknown} params */
  notification(project, client, method, params) {
    if (!this.host.currentConnection(project, client) || !isHistoryNotification(params)) return;
    if (
      [
        "thread/started",
        "turn/started",
        "turn/completed",
        "areal/thread/configured",
        "areal/task/changed",
        "areal/queue/changed",
      ].includes(method)
    )
      this.host.scheduleReconciliation(project);
    const threadId = params?.threadId ?? params?.thread?.id ?? params?.interaction?.threadId;
    if (threadId && project.observationErrors?.[threadId]?.code === "RESPONSE_TOO_LARGE") return;
    if (method === "areal/thread/configured" && params?.threadId && params.configuration) {
      project.configurations ??= {};
      const stored = project.configurations[params.threadId];
      const previous = modelRecord(stored) ? stored : undefined;
      project.configurations[params.threadId] = {
        ...params.configuration,
        modelName:
          params.configuration.defaultModelRevision &&
          params.configuration.defaultModelRevision === previous?.defaultModelRevision
            ? previous.modelName
            : undefined,
      };
      this.host.onChange();
    }
    if (["areal/mcp/app/tools/pending", "areal/mcp/app/tools/cancelled"].includes(method)) {
      this.host.onMcpPageToolNotice?.({
        projectId: project.logicalProjectId ?? project.id,
        client,
        method,
        params,
      });
      return;
    }
    if (method === "areal/mcp/app/notification")
      this.host.onMcpAppNotification?.({
        projectId: project.logicalProjectId ?? project.id,
        ...params,
      });
    this.host.analytics.observe(project.id, method, params);
    if (threadId && method === "areal/thread/edited" && this.supportsBoundedHistory(client)) {
      const window = this.historyWindow(project, threadId);
      if (window) {
        window.invalidated = true;
        window.epoch++;
      }
      void this.openThread(project, threadId).catch(() => {});
      void this.refreshThreadSummary(project, threadId).catch(() => {});
      return;
    }
    project.model.event(method, params);
    if (params?.task)
      void this.host.taskWorkspaceOwners.observeProject(project).catch(
        /** @param {unknown} error */ (error) => {
          project.error = error instanceof Error ? error.message : String(error);
          this.host.onChange();
        },
      );
    if (method === "areal/context/compacted" && params?.threadId) {
      void this.openThread(project, params.threadId).catch(() => {});
    }
    if (!isTaskDraftConfiguration(project.configurations?.[params.threadId ?? ""]))
      this.host.notifications.observe(
        project.logicalProjectId ? { ...project, id: project.logicalProjectId } : project,
        method,
        params,
        this.host.library.value,
      );
    if (method === "thread/started" || method === "turn/started" || method === "turn/completed") {
      void this.host.library
        .recordThreadActivity(
          project.id,
          params.threadId ?? params.thread?.id,
          method === "turn/completed" ? (params.turn?.id ?? params.turnId) : undefined,
        )
        .catch(() => {});
    }
    // 生命周期通知不带完整时间戳；仅回读目标摘要，并合并同一连接的重叠刷新。
    if (
      [
        "thread/started",
        "turn/started",
        "turn/completed",
        "areal/thread/configured",
        "areal/thread/edited",
      ].includes(method)
    ) {
      void this.refreshThreadSummary(project, threadId).catch(() => {});
    }
    if (method === "turn/completed") this.host.providers.requestReconciliation();
    if (
      threadId &&
      method === "turn/completed" &&
      this.supportsBoundedHistory(client) &&
      Buffer.byteLength(JSON.stringify(project.model.state.threads[threadId] ?? {})) >
        historyMaxBytes
    )
      void this.openThread(project, threadId).catch(() => {});
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('@areal/runtime-client/core').CoreClient} client */
  async startTaskMonitor(project, client) {
    project.taskNotificationMonitor = new TaskNotificationMonitor(
      this.host.ownerTasks,
      project,
      client,
      (notice) => {
        if (this.host.currentConnection(project, client)) this.host.notifications.publish(notice);
      },
      (error) =>
        console.warn(
          this.host.providers.redact(
            `任务通知读取失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      async (tasks, facts, baselineTaskIds) => {
        if (!this.host.currentConnection(project, client)) return;
        /** @type {Map<string,{id:string,status:string,threadId?:string|null}>} */
        const completed = new Map(
          tasks.flatMap((task) =>
            task.mode === "scheduled" && task.latestRun?.status === "completed"
              ? [[task.latestRun.id, task.latestRun]]
              : [],
          ),
        );
        /** @type {Set<string>} */
        const scheduledTasks = new Set();
        for (const taskId of new Set([
          ...baselineTaskIds,
          ...facts.flatMap((fact) => (fact.taskId ? [fact.taskId] : [])),
        ])) {
          this.host.requireConnection(project, client);
          const task = await client
            .request("areal/task/read", { taskId }, { decode: readTask })
            .catch((error) => {
              if (modelRecord(error) && error.code === -32004) return null;
              throw error;
            });
          this.host.requireConnection(project, client);
          if (task?.mode !== "scheduled") continue;
          scheduledTasks.add(taskId);
          if (baselineTaskIds.includes(taskId))
            for (const run of task.runs) if (run.status === "completed") completed.set(run.id, run);
        }
        for (const fact of facts) {
          if (!fact.taskId || !fact.runId || !fact.threadId) continue;
          if (scheduledTasks.has(fact.taskId))
            completed.set(fact.runId, {
              id: fact.runId,
              threadId: fact.threadId,
              status: "completed",
            });
        }
        if (
          [...completed.values()].some(
            (run) =>
              run.threadId && !project.summaries.some((thread) => thread.id === run.threadId),
          )
        ) {
          await this.listThreads(project);
          this.host.requireConnection(project, client);
        }
        for (const run of completed.values()) {
          if (
            !run.threadId ||
            this.host.library.value.threads[
              `${project.logicalProjectId ?? project.id}:${run.threadId}`
            ]?.scheduledCompletionId === run.id
          )
            continue;
          const { thread } = this.supportsBoundedHistory(client)
            ? await this.readObservation(project, run.threadId, { client, install: false })
            : await client.request(
                "thread/read",
                { threadId: run.threadId, includeTurns: true },
                { decode: readObservationResult },
              );
          this.host.requireConnection(project, client);
          const completionId = thread.turns?.findLast((turn) => turn.status === "completed")?.id;
          await this.host.library.recordScheduledCompletion(project.id, run, completionId);
        }
      },
    );
    await project.taskNotificationMonitor.start();
  }

  /** @param {import('./project-state.cjs').CoreProject} project */
  listThreads(project) {
    return this.catalog.listThreads(project);
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {string|undefined} threadId */
  refreshThreadSummary(project, threadId) {
    return this.catalog.refreshThreadSummary(project, threadId);
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {string} threadId @param {unknown} error @param {{refreshPending?:boolean,id?:string}} [options] */
  observationFailure(project, threadId, error, { refreshPending = false, id = randomUUID() } = {}) {
    project.observationErrors ??= {};
    project.observationErrors[threadId] = {
      id,
      projectId: project.id,
      threadId,
      connectionGeneration: project.connectionGeneration,
      code: modelRecord(error) ? (error.code ?? "OBSERVATION_FAILED") : "OBSERVATION_FAILED",
      reason: modelRecord(error) ? error.reason : undefined,
      message: this.host.providers.redact(error instanceof Error ? error.message : String(error)),
      retryable: retryableRead(error),
      refreshPending,
      recovery: { kind: retryableRead(error) ? "retryRead" : "none" },
    };
    this.host.onChange();
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {string} threadId */
  async openThread(project, threadId) {
    const client = project.client,
      generation = project.connectionGeneration;
    project.observationReads ??= new Map();
    const existing = project.observationReads?.get(threadId);
    if (existing && existing.client === client && existing.generation === generation)
      return existing.promise;
    /** @type {import('./project-state.cjs').ObservationRead} */
    let attempt;
    const id = randomUUID();
    const current = () =>
      this.host.currentConnection(project, client) &&
      generation === project.connectionGeneration &&
      project.observationReads?.get(threadId) === attempt;
    const deadline = Date.now() + 30000;
    const promise = Promise.resolve()
      .then(async () => {
        for (let retries = 0; ; retries++) {
          if (!current() || !client)
            throw Object.assign(new Error("连接已换代，请等待状态恢复"), {
              code: "STALE_CONNECTION",
            });
          try {
            await this.observeThread(project, threadId, { client, current, deadline });
            if (current()) {
              delete project.observationErrors?.[threadId];
              this.host.onChange();
            }
            return;
          } catch (error) {
            if (!current()) throw error;
            const delay = observationDelays[retries];
            const retry =
              retryableRead(error) &&
              client?.ready &&
              delay !== undefined &&
              Date.now() + delay < deadline &&
              !this.host.lifecycleOperations.blocking(project.id, threadId) &&
              !this.host.lifecycleOperations.activeTargets.has(project.id);
            this.observationFailure(project, threadId, error, {
              refreshPending: retry,
              id: attempt.id,
            });
            if (!retry) throw error;
            await sleep(delay);
          }
        }
      })
      .finally(() => {
        if (project.observationReads?.get(threadId) === attempt)
          project.observationReads?.delete(threadId);
      });
    attempt = { client, generation, id, promise };
    project.observationReads.set(threadId, attempt);
    return promise;
  }

  /** @param {import('@areal/runtime-client/core').CoreClient|null|undefined} client */
  supportsBoundedHistory(client) {
    return (
      client?.capabilities?.features?.boundedObservation === true &&
      client.capabilities.features.boundedHistory === true
    );
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {string} threadId */
  historyWindow(project, threadId) {
    return this.historyWindows?.get(`${project.id}:${threadId}`);
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('./history-state.cjs').HistoryWindow} window @param {import('@areal/workbench/core-model-contract').CoreThread} [thread] @param {Parameters<import('@areal/workbench/core-model').CoreTaskModel['replace']>[1]} [metadata] */
  publishHistory(project, window, thread = project.model.state.threads[window.threadId], metadata) {
    if (this.historyWindow(project, window.threadId) !== window) return;
    if (!thread) return;
    project.model.replace(
      {
        ...thread,
        displayHistory: {
          supported: true,
          complete:
            window.displayed?.complete ??
            (window.complete && !historyGaps(window).some((gap) => gap.atTop)),
          gaps: historyGaps(window),
          omitted: window.displayed?.omitted ?? window.omitted,
          loadingOlder: !!window.olderRead,
          loadingLatest: !window.displayed && !!window.latestTurn.read,
          latestTurnComplete: !!window.displayed || window.latestTurn.complete,
          loadingItems: Object.fromEntries(window.loading),
          baselineFirstItemId: window.baselineFirstItemId,
          viewGeneration: window.viewGeneration,
          restoringItems: window.stalePages.flatMap((page) =>
            page.data.map((entry) => entry.sourceItemId),
          ),
          pageTopology: window.pageRecords
            .filter((record) => record.items.length)
            .map((record) => ({
              id: record.id,
              items: record.items,
            })),
        },
      },
      metadata,
    );
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('./history-contract.cjs').ObservationResult} input @param {import('@areal/runtime-client/core').CoreClient|null} [client] */
  installObservation(project, input, client = project.client) {
    const result = input;
    const thread = result.thread;
    const previousThread = project.model.state.threads[thread.id];
    const desktop = thread.desktop;
    if (desktop?.configuration) {
      project.configurations ??= {};
      const previous = project.configurations[thread.id];
      if ((previous?.revision ?? -1) <= (desktop.configuration.revision ?? 0))
        project.configurations[thread.id] = {
          ...desktop.configuration,
          ...(previous?.revision === desktop.configuration.revision &&
          previous?.defaultModelRevision === desktop.configuration.defaultModelRevision
            ? { modelName: previous?.modelName, resolvedParameters: previous?.resolvedParameters }
            : {}),
        };
    }
    const metadata = {
      queue: desktop?.queue,
      interactions:
        desktop?.interactions && desktop.interactionRevision !== undefined
          ? { revision: desktop.interactionRevision, data: desktop.interactions }
          : undefined,
    };
    if (!result.history) {
      project.model.replace({ ...thread, displayHistory: { supported: false } }, metadata);
    } else {
      if (!client) throw historyFailure("会话连接尚未就绪。");
      this.historyWindows ??= new Map();
      for (const [key, window] of this.historyWindows) {
        if (this.host.projects.get(window.project.id) !== window.project)
          this.historyWindows.delete(key);
      }
      const key = `${project.id}:${thread.id}`,
        previous = this.historyWindows.get(key);
      if (!previous && this.historyWindows.size >= historyViewLimit) {
        const victim = [...this.historyWindows.entries()].find(
          ([, window]) => window.views.size === 0,
        );
        if (!victim) throw historyFailure("同时打开的历史视图已达上限，请先关闭一个视图。");
        this.historyWindows.delete(victim[0]);
        const { project: owner, threadId } = victim[1];
        const { [threadId]: _removed, ...threads } = owner.model.state.threads;
        const { [threadId]: _interactions, ...otherInteractions } = owner.model.state.interactions;
        const { [threadId]: _queue, ...queues } = owner.model.state.queues;
        owner.model.publish({ threads, interactions: otherInteractions, queues });
      }
      const latestTurn = thread.turns.at(-1);
      const latestId = latestTurn?.id;
      const latestComplete =
        result.history.complete ||
        !result.history.nextCursor ||
        !latestId ||
        thread.turns.some((turn) => turn.id !== latestId);
      const preserve =
        !latestComplete &&
        previous &&
        !previous.invalidated &&
        previous.client === project.client &&
        previous.generation === project.connectionGeneration &&
        previousThread?.turns?.at(-1)?.id === latestId;
      const prefix = preserve
        ? (previousThread.turns?.at(-1)?.items ?? []).map(
            (item) => previous.loaded.get(item.id)?.placeholder ?? item,
          )
        : [];
      // 补全本轮时最后一页常带上一轮的尾部条目；同一连接、未失效的重新观察会立刻重新读到它们。
      // 先保留这些已显示的条目，避免顶部内容消失再出现造成整列跳动；“加载更早”分页仍随新窗口重置。
      const paged = new Set(
        (preserve ? previous.pages : []).flatMap((page) =>
          page.data.map((entry) => entry.sourceItemId),
        ),
      );
      const retained = preserve
        ? (previousThread.turns ?? []).slice(0, -1).flatMap((turn) =>
            (turn.items ?? [])
              .filter((item) => !paged.has(item.id))
              .map((item) => ({
                sourceTurnId: turn.id,
                sourceItemId: item.id,
                sourceTurnStatus: turn.status,
                turn,
                item: previous.loaded.get(item.id)?.placeholder ?? item,
              })),
          )
        : [];
      const seen = new Set(
        thread.turns?.flatMap((turn) => turn.items ?? []).map((item) => item.id),
      );
      const knownUsers = new Map(
        prefix.filter((item) => item.type === "userMessage").map((item) => [item.id, item]),
      );
      const observed = {
        ...thread,
        turns: (thread.turns ?? []).map((turn) => ({
          ...turn,
          items: (turn.items ?? []).map((item) =>
            item.type === "historyDeferred" &&
            item.originalType === "userMessage" &&
            knownUsers.has(item.id)
              ? (knownUsers.get(item.id) ?? item)
              : item,
          ),
        })),
      };
      /** @type {import('./history-state.cjs').HistoryWindow} */
      const window = {
        project,
        threadId: thread.id,
        ...result.history,
        views: previous?.views ?? new Set(),
        targets: new Map(previous?.targets),
        stalePages:
          previous && !previous.invalidated
            ? [...previous.pages, ...previous.stalePages]
                .map((page) => ({
                  ...page,
                  data: page.data.filter((entry) => !seen.has(entry.sourceItemId)),
                }))
                .filter((page) => page.data.length && this.pinnedPage(previous, page))
                .slice(0, historyPageLimit)
            : [],
        viewGeneration: randomUUID(),
        client,
        generation: project.connectionGeneration,
        latestTurn: { id: latestId, complete: latestComplete, read: null },
        // 已补全的窗口被重新观察时，屏幕上仍是上一窗口的完整内容；补全追上之前沿用其边界状态，
        // 不让“恢复本轮/加载更早”提示在已显示的对话上方出现又消失。
        displayed:
          preserve && previous.latestTurn.complete && !previous.pages.length
            ? { complete: previous.complete, omitted: previous.omitted }
            : undefined,
        preservedLatestItems: new Map(
          prefix.filter((item) => !seen.has(item.id)).map((item) => [item.id, item]),
        ),
        latestSeen: seen,
        pages: [],
        pageRecords: [],
        loaded: new Map(),
        loading: new Map(),
        omitted: false,
        epoch: 0,
        baselineCursor: result.history.nextCursor,
        baselineComplete: result.history.complete,
        baselineFirstItemId: thread.turns?.flatMap((turn) => turn.items ?? [])[0]?.id,
      };
      const previousOrder = new Map(
        (previousThread?.turns ?? [])
          .flatMap((turn) => turn.items ?? [])
          .map((item, index) => [item.id, index]),
      );
      this.historyWindows.delete(key);
      this.historyWindows.set(key, window);
      this.publishHistory(
        project,
        window,
        mergeHistory(observed, [
          ...window.stalePages
            .flatMap((page) => page.data)
            .sort(
              (a, b) =>
                (previousOrder.get(a.sourceItemId) ?? -1) -
                (previousOrder.get(b.sourceItemId) ?? -1),
            ),
          ...retained,
          ...(latestTurn
            ? prefix.map((item) => ({
                sourceTurnId: latestTurn.id,
                sourceItemId: item.id,
                sourceTurnStatus: latestTurn.status,
                turn: latestTurn,
                item,
              }))
            : []),
        ]),
        metadata,
      );
      if (window.views.size && !previous?.invalidated)
        void this.hydrateLatest(project, window).catch(() => {});
    }
    for (const turn of thread.turns ?? []) {
      if (
        turn.id &&
        ["completed", "failed", "interrupted"].includes(turn.status ?? "") &&
        previousThread?.turns?.some(
          (previous) => previous.id === turn.id && previous.status === "inProgress",
        )
      ) {
        void this.host.library.recordThreadActivity(project.id, thread.id, turn.id).catch(() => {});
      }
    }
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {string} threadId @param {import('./history-state.cjs').ReadOptions} [options] */
  async readObservation(
    project,
    threadId,
    {
      client = project.client,
      current = () => this.host.currentConnection(project, client),
      timeoutMs,
      install = true,
      resume = false,
    } = {},
  ) {
    if (!client) throw historyFailure("会话连接尚未就绪。");
    const bounded = this.supportsBoundedHistory(client);
    if (resume && bounded && client.capabilities?.features?.boundedResume !== true)
      throw historyFailure("当前 Core 无法按页恢复浏览器连接，请更新 Core 后重试。");
    const method = resume ? "thread/resume" : "areal/thread/observe";
    return client.request(
      method,
      {
        threadId,
        ...(bounded
          ? {
              mode:
                client.capabilities?.features?.conversationObservation === true
                  ? "conversation"
                  : "bounded",
              maxBytes: historyMaxBytes,
            }
          : {}),
      },
      {
        decode: readObservationResult,
        timeoutMs,
        ...(bounded ? { maxResponseBytes: historyMaxBytes } : {}),
        onResult: (result) => {
          if (current() && result.thread?.id === threadId && install)
            this.installObservation(project, result, client);
        },
      },
    );
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('./history-state.cjs').HistoryWindow} window @returns {Promise<void>} */
  hydrateLatest(project, window) {
    if (window.invalidated) return Promise.reject(historyFailure("历史视图已变化，请重新加载。"));
    if (window.latestTurn.read) return window.latestTurn.read;
    if (window.latestTurn.complete) return Promise.resolve();
    const { client, generation, epoch, threadId } = window;
    const current = () =>
      this.host.currentConnection(project, client) &&
      project.connectionGeneration === generation &&
      this.historyWindow(project, threadId) === window &&
      window.epoch === epoch &&
      window.views.size > 0;
    const loading = Promise.resolve().then(async () => {
      try {
        /** @type {import('./history-contract.cjs').HistoryEntry[]} */
        const entries = [];
        let cursor = window.baselineCursor;
        let page;
        do {
          if (!current()) throw historyFailure("历史视图已变化，请重新加载。");
          page = await client.request(
            "areal/conversation/history",
            { threadId, view: "own", cursor, maxBytes: historyPageBytes },
            { decode: readHistoryPage, maxResponseBytes: historyPageBytes },
          );
          if (!current()) throw historyFailure("历史视图已变化，请重新加载。");
          this.validateHistoryPage(window, page, cursor);
          entries.unshift(...page.data);
          cursor = page.nextCursor;
        } while (
          !page.complete &&
          !page.data.some((entry) => entry.sourceTurnId !== window.latestTurn.id)
        );
        for (const entry of entries) window.latestSeen.add(entry.sourceItemId);
        const authoritative = new Map(entries.map((entry) => [entry.sourceItemId, entry.item]));
        const displayed = project.model.state.threads[threadId];
        const reconciled = {
          ...displayed,
          turns: (displayed.turns ?? []).map((turn) => ({
            ...turn,
            items: (turn.items ?? []).map((item) =>
              item.type !== "userMessage" && window.preservedLatestItems.get(item.id) === item
                ? (authoritative.get(item.id) ?? item)
                : item,
            ),
          })),
        };
        const merged = mergeHistory(reconciled, entries);
        const thread = {
          ...merged,
          turns: (merged.turns ?? []).map((turn) => ({
            ...turn,
            items: (turn.items ?? []).filter(
              (item) => !window.preservedLatestItems.has(item.id) || window.latestSeen.has(item.id),
            ),
          })),
        };
        window.latestTurn.complete = true;
        window.displayed = undefined;
        window.baselineCursor = window.nextCursor = page.nextCursor;
        window.baselineComplete = window.complete = page.complete;
        window.preservedLatestItems.clear();
        window.baselineFirstItemId = (thread.turns ?? []).flatMap(
          (turn) => turn.items ?? [],
        )[0]?.id;
        window.latestTurn.read = null;
        this.publishHistory(project, window, thread);
      } catch (error) {
        // 补全失败时公开真实边界，让恢复提示与重试入口出现。
        window.displayed = undefined;
        if (current() && historyReason(error) === "HISTORY_CURSOR_STALE") {
          window.invalidated = true;
          window.epoch++;
        }
        throw error;
      } finally {
        if (window.latestTurn.read === loading) {
          window.latestTurn.read = null;
          this.publishHistory(project, window);
        }
      }
    });
    window.latestTurn.read = loading;
    this.publishHistory(project, window);
    return loading;
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('./history-state.cjs').HistoryWindow} window */
  async refreshHistory(project, window) {
    window.invalidated = true;
    window.epoch++;
    await project.observationReads?.get(window.threadId)?.promise.catch(() => {});
    if (
      this.historyWindow(project, window.threadId) === window &&
      this.host.currentConnection(project, window.client) &&
      project.connectionGeneration === window.generation
    )
      await this.openThread(project, window.threadId);
  }

  /** @param {import('./history-state.cjs').HistoryWindow} window @param {import('./history-contract.cjs').HistoryPage} value @param {string|null} cursor */
  validateHistoryPage(window, value, cursor) {
    const page = value;
    if (
      page.snapshotId !== window.snapshotId ||
      !Array.isArray(page.data) ||
      page.nextCursor === cursor ||
      (!page.complete && (!page.nextCursor || !page.data.length))
    )
      throw historyFailure("历史页的版本或游标无效，请重新打开聊天。");
    if (
      page.data.some(
        (entry) =>
          entry.sourceThreadId !== window.threadId ||
          entry.fragment ||
          entry.item?.id !== entry.sourceItemId,
      )
    )
      throw historyFailure("历史页与当前聊天不匹配。");
    return page;
  }

  /** @param {import('./history-state.cjs').HistoryWindow} window @param {import('./history-contract.cjs').HistoryPage} page */
  pinnedPage(window, page) {
    return [...window.targets.values()].some(
      ({ anchor }) =>
        anchor &&
        page.data.some(
          (entry) => entry.sourceTurnId === anchor.turnId && entry.sourceItemId === anchor.itemId,
        ),
    );
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('./history-state.cjs').HistoryWindow} window @param {import('./history-state.cjs').Anchor} [missing] */
  pruneReadingSnapshots(project, window, missing) {
    const previous = window.stalePages;
    const retained = previous
      .map((page) => ({
        ...page,
        data: page.data.filter(
          (entry) =>
            !missing ||
            entry.sourceTurnId !== missing.turnId ||
            entry.sourceItemId !== missing.itemId,
        ),
      }))
      .filter((page) => page.data.length && this.pinnedPage(window, page));
    const kept = new Set(retained.flatMap((page) => page.data.map((entry) => entry.sourceItemId)));
    if (previous.every((page) => page.data.every((entry) => kept.has(entry.sourceItemId)))) return;
    const authoritative = new Set(
      window.pages.flatMap((page) => page.data.map((entry) => entry.sourceItemId)),
    );
    const removed = new Set(
      previous
        .flatMap((page) => page.data.map((entry) => entry.sourceItemId))
        .filter((id) => !kept.has(id) && !authoritative.has(id)),
    );
    window.stalePages = retained;
    for (const id of removed) window.loaded.delete(id);
    const thread = project.model.state.threads[window.threadId];
    this.publishHistory(project, window, {
      ...thread,
      turns: (thread.turns ?? []).map((turn) => ({
        ...turn,
        items: (turn.items ?? []).filter((item) => !removed.has(item.id)),
      })),
    });
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('./history-state.cjs').HistoryWindow} window @param {import('./history-state.cjs').HistoryWindow['pages']} input @param {import('./history-state.cjs').PageRecord[]} incoming @param {string|null} startCursor */
  cacheHistoryPages(project, window, input, incoming, startCursor) {
    const records = [...window.pageRecords];
    for (const record of incoming) {
      const index = records.findIndex((current) => current.cursor === record.cursor);
      if (index < 0) records.push(record);
      else records[index] = { ...record, id: records[index].id };
    }
    const added = input.map((page) => ({
      ...page,
      pageId:
        records.find(
          (record) => record.cursor === incoming.find((entry) => entry.id === page.pageId)?.cursor,
        )?.id ?? page.pageId,
    }));
    const target = added.at(-1)?.pageId;
    const replaced = new Set(added.flatMap((page) => page.data.map((entry) => entry.sourceItemId)));
    const stale = window.stalePages
      .map((page) => ({
        ...page,
        data: page.data.filter((entry) => !replaced.has(entry.sourceItemId)),
      }))
      .filter((page) => page.data.length && this.pinnedPage(window, page));
    const pages = [
      ...window.pages.filter((page) => !added.some((next) => next.pageId === page.pageId)),
      ...added,
    ];
    const position = (/** @type {string} */ id) => records.findIndex((record) => record.id === id);
    const targetIndex = target ? position(target) : -1;
    while (pages.length + stale.length > historyPageLimit) {
      const victim = pages
        .filter((page) => page.pageId !== target && !this.pinnedPage(window, page))
        .sort(
          (a, b) =>
            Math.abs(position(b.pageId) - targetIndex) - Math.abs(position(a.pageId) - targetIndex),
        )[0];
      if (!victim) return false;
      pages.splice(pages.indexOf(victim), 1);
    }
    const baseline = project.model.state.threads[window.threadId];
    const removed = new Set(
      [...window.pages, ...window.stalePages].flatMap((page) =>
        page.data.map((entry) => entry.sourceItemId),
      ),
    );
    const shown = new Map(
      (baseline.turns ?? []).flatMap((turn) => (turn.items ?? []).map((item) => [item.id, item])),
    );
    const staleIds = new Set(
      window.stalePages.flatMap((page) => page.data.map((entry) => entry.sourceItemId)),
    );
    let thread = {
      ...baseline,
      turns: (baseline.turns ?? [])
        .map((turn) => ({
          ...turn,
          items: (turn.items ?? []).filter((item) => !removed.has(item.id)),
        }))
        .filter((turn) => turn.items.length || turn.status === "inProgress"),
    };
    pages.sort((a, b) => position(a.pageId) - position(b.pageId));
    const entries = [...pages].reverse().flatMap((page) => page.data);
    const oldOrder = (baseline.turns ?? [])
      .flatMap((turn) => turn.items ?? [])
      .map((item) => item.id);
    const snapshots = stale
      .flatMap((page) => page.data)
      .sort((a, b) => oldOrder.indexOf(a.sourceItemId) - oldOrder.indexOf(b.sourceItemId));
    for (const entry of snapshots) {
      const index = oldOrder.indexOf(entry.sourceItemId);
      const next = entries.findIndex((current) => oldOrder.indexOf(current.sourceItemId) > index);
      const previous = entries.findLastIndex((current) => {
        const position = oldOrder.indexOf(current.sourceItemId);
        return position >= 0 && position < index;
      });
      entries.splice(next >= 0 ? next : previous + 1, 0, entry);
    }
    thread = mergeHistory(
      thread,
      entries.map((entry) => ({
        ...entry,
        item: staleIds.has(entry.sourceItemId)
          ? entry.item
          : (shown.get(entry.sourceItemId) ?? entry.item),
      })),
    );
    const retained = new Set(
      [...pages, ...stale].flatMap((page) => page.data.map((entry) => entry.sourceItemId)),
    );
    for (const id of removed) if (!retained.has(id)) window.loaded.delete(id);
    window.pages = pages;
    window.stalePages = stale;
    const resident = new Set(pages.map((page) => page.pageId));
    const pinned = new Set(
      pages.filter((page) => this.pinnedPage(window, page)).map((page) => page.pageId),
    );
    let bytes = 2;
    const topology = new Set();
    for (const record of [...records].sort(
      (a, b) =>
        Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
        Number(resident.has(b.id)) - Number(resident.has(a.id)) ||
        Math.abs(position(a.id) - targetIndex) - Math.abs(position(b.id) - targetIndex),
    )) {
      const size = Buffer.byteLength(JSON.stringify({ id: record.id, items: record.items })) + 1;
      if (record.items.length && bytes + size <= historyTopologyBytes) {
        bytes += size;
        topology.add(record.id);
      }
    }
    window.pageRecords = records.map((record) =>
      topology.has(record.id) ? record : { ...record, items: [] },
    );
    if (startCursor && window.nextCursor === startCursor) {
      const last = added.at(-1);
      if (last) {
        window.nextCursor = last.nextCursor;
        window.complete = last.complete;
      }
    }
    window.omitted = records.length > pages.length;
    this.publishHistory(project, window, thread);
    return true;
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('./history-state.cjs').HistoryWindow} window @param {string} viewId @param {number} revision @param {import('./history-state.cjs').Anchor} anchor @returns {Promise<import('@areal/workbench/desktop-contract/conversation').AnchorResult>} */
  async ensureAnchor(project, window, viewId, revision, anchor) {
    const intent = window.targets.get(viewId);
    const { client, generation, epoch, threadId } = window;
    const current = () =>
      this.host.currentConnection(project, client) &&
      project.connectionGeneration === generation &&
      this.historyWindow(project, threadId) === window &&
      !window.invalidated &&
      window.epoch === epoch &&
      window.views.has(viewId) &&
      window.targets.get(viewId) === intent;
    const base = {
      supported: /** @type {const} */ (true),
      revision,
      viewGeneration: window.viewGeneration,
    };
    const matches = (/** @type {import('./history-contract.cjs').HistoryEntry} */ entry) =>
      entry.sourceTurnId === anchor.turnId && entry.sourceItemId === anchor.itemId;
    try {
      if (!current()) return { ...base, kind: "cancelled" };
      await this.hydrateLatest(project, window);
      if (!current()) return { ...base, kind: "cancelled" };
      const shown = project.model.state.threads[threadId]?.turns
        ?.find((turn) => turn.id === anchor.turnId)
        ?.items?.find((item) => item.id === anchor.itemId);
      const stale = window.stalePages.some((page) => page.data.some(matches));
      if (shown && !stale)
        return shown.type === "historyDeferred"
          ? { ...base, kind: "limited", reason: "deferred" }
          : { ...base, kind: "ready" };
      const known = window.pageRecords.find((record) =>
        record.items.some((item) => item.turnId === anchor.turnId && item.itemId === anchor.itemId),
      );
      // 拓扑被裁剪不代表目标不存在；从第一个未知缺口回读，仍遵守本次扫描预算。
      let cursor =
        known?.cursor ??
        window.pageRecords.find((record) => !record.items.length)?.cursor ??
        window.nextCursor;
      const startCursor = cursor;
      /** @type {import('./history-state.cjs').PageRecord[]} */
      const records = [];
      /** @type {import('./history-state.cjs').HistoryWindow['pages']} */
      const nearby = [];
      let bytes = 0;
      for (let reads = 0; cursor && reads < 32; reads++) {
        const page = await client.request(
          "areal/conversation/history",
          { threadId, view: "own", cursor, maxBytes: historyPageBytes },
          { decode: readHistoryPage, maxResponseBytes: historyPageBytes },
        );
        if (!current()) return { ...base, kind: "cancelled" };
        this.validateHistoryPage(window, page, cursor);
        bytes += Buffer.byteLength(JSON.stringify(page));
        if (bytes > 8 * 1024 * 1024) return { ...base, kind: "limited", reason: "scanBudget" };
        const record = {
          id: window.pageRecords.find((record) => record.cursor === cursor)?.id ?? randomUUID(),
          cursor,
          items: pageTopology(page.data),
        };
        records.push(record);
        nearby.push({ ...page, pageId: record.id });
        if (nearby.length > 2) nearby.shift();
        const found = page.data.find(matches);
        if (found) {
          if (found.item.type === "historyDeferred")
            return { ...base, kind: "limited", reason: "deferred" };
          if (!this.cacheHistoryPages(project, window, nearby, records, startCursor))
            return { ...base, kind: "limited", reason: "cacheBudget" };
          return { ...base, kind: "ready" };
        }
        cursor = page.nextCursor;
        if (page.complete) {
          this.pruneReadingSnapshots(project, window, anchor);
          return { ...base, kind: "missing" };
        }
      }
      if (!cursor) this.pruneReadingSnapshots(project, window, anchor);
      return cursor
        ? { ...base, kind: "limited", reason: "scanBudget" }
        : { ...base, kind: "missing" };
    } catch (error) {
      if (!current()) return { ...base, kind: "cancelled" };
      if (historyReason(error) === "HISTORY_CURSOR_STALE") {
        await this.refreshHistory(project, window).catch(() => {});
        return { ...base, kind: "cancelled" };
      }
      return { ...base, kind: "limited", reason: "unavailable" };
    }
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {import('@areal/workbench/desktop-contract').HistoryRequest} request */
  historyCommand(project, request) {
    return historyCommand(this, project, request);
  }

  /** @param {import('./project-state.cjs').CoreProject} project @param {string} threadId @param {import('./history-state.cjs').ObserveOptions} options */
  async observeThread(project, threadId, { client, current, deadline }) {
    /** @param {import('./history-contract.cjs').ObservationResult} result */
    const acceptSnapshot = (result) => {
      if (!current() || result.thread?.id !== threadId) return;
      delete project.observationErrors?.[threadId];
      this.installObservation(project, result, client);
    };
    try {
      if (
        !this.supportsBoundedHistory(client) &&
        ((project.summaries ?? []).find((item) => item.id === threadId)?.desktop?.archived ||
          project.model.state?.threads?.[threadId]?.desktop?.archived)
      ) {
        const result = await client.request(
          "thread/read",
          { threadId, includeTurns: true },
          {
            decode: readObservationResult,
            onResult: acceptSnapshot,
            timeoutMs: Math.min(6000, Math.max(1, deadline - Date.now())),
          },
        );
        this.host.requireConnection(project, client);
        if (result.thread?.id !== threadId) throw new Error("恢复结果与目标会话不匹配");
        return;
      }
      if (!client.capabilities?.methods?.includes("areal/thread/observe")) {
        throw new Error("当前 Core 不支持安全观察已有聊天；请更新 Core 后重新连接");
      }
      const resumed = await this.readObservation(project, threadId, {
        client,
        current,
        timeoutMs: Math.min(6000, Math.max(1, deadline - Date.now())),
      });
      this.host.requireConnection(project, client);
      if (resumed.thread?.id !== threadId) throw new Error("恢复结果与目标会话不匹配");
      const configuration = resumed.thread.desktop?.configuration;
      if (
        configuration?.model === null &&
        configuration.defaultModelRevision &&
        !resumed.thread.desktop?.archived &&
        resumed.thread.conversation?.policy?.kind !== "sideReadOnlyV1"
      ) {
        await client.request(
          "areal/thread/inspect",
          { threadId },
          {
            decode: readInspection,
            timeoutMs: Math.min(6000, Math.max(1, deadline - Date.now())),
            onResult: (inspection) => {
              const latest = project.configurations[threadId];
              if (
                !current() ||
                latest?.revision !== configuration.revision ||
                latest?.defaultModelRevision !== configuration.defaultModelRevision ||
                inspection.configuration.revision !== configuration.revision ||
                inspection.configuration.defaultModelRevision !== configuration.defaultModelRevision
              )
                return;
              project.configurations[threadId] = {
                ...latest,
                modelName: inspection.modelName,
                resolvedParameters: inspection.resolvedParameters,
              };
              this.host.onChange();
            },
          },
        );
      }
    } catch (error) {
      if (
        !this.supportsBoundedHistory(client) &&
        isObservationSizeFailure(error) &&
        this.host.currentConnection(project, client) &&
        client.ready
      ) {
        project.observationErrors ??= {};
        project.observationErrors[threadId] = {
          connectionGeneration: project.connectionGeneration,
          code: "RESPONSE_TOO_LARGE",
          message: "聊天历史超过当前支持的 64 MiB，无法完整加载。",
          retryable: false,
        };
        this.host.onChange();
        if (client.capabilities?.methods?.includes("areal/subscription/remove")) {
          try {
            await client.request(
              "areal/subscription/remove",
              { threadIds: [threadId] },
              { timeoutMs: 2500 },
            );
          } catch (removeError) {
            if (!this.host.currentConnection(project, client) || !client.ready) throw removeError;
          }
        }
      }
      throw error;
    }
  }
}

module.exports = { HistoryObservation, isObservationSizeFailure };
