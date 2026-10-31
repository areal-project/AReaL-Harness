// @ts-check
import {
  modelRecord,
  isCoreModelChange,
  isCoreItem,
  isCoreTurn,
  isCoreThread,
  isCoreGoals,
  isCorePlan,
  isCoreQueue,
  isCoreTask,
  isCoreInteraction,
} from "./core-model-contract.js";
/** @import {CoreModelState,CoreThread,CoreInteractions,CoreQueue,CoreGoals,CorePlan,CoreTask} from './core-model-contract.js' */
/** 可重建的客户端投影；不持久化执行事实，不依赖 React 或平台模块。 */
export class CoreTaskModel {
  constructor() {
    /** @type {CoreModelState} */
    this.state = { connected: false, threads: {}, interactions: {}, queues: {}, error: null };
    /** @type {Set<()=>void>} */
    this.listeners = new Set();
  }

  /** @param {()=>void} listener */
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  /** @param {Partial<CoreModelState>} [patch] */
  publish(patch = {}) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** @param {boolean} connected @param {string|null} [error] */
  connection(connected, error = null) {
    this.publish({ connected, error });
  }
  /** @param {CoreThread} thread @param {{queue?:CoreQueue,interactions?:CoreInteractions}} [metadata] */
  replace(thread, { queue, interactions } = {}) {
    const old = this.state.threads[thread.id];
    // A snapshot requested before an attachment may arrive after its committed event.
    const currentRevision = old?.toolsetRevision ?? 0;
    const incomingRevision = thread.toolsetRevision ?? 0;
    const value =
      currentRevision > incomingRevision
        ? { ...thread, dynamicTools: old.dynamicTools, toolsetRevision: currentRevision }
        : thread;
    this.publish({
      threads: { ...this.state.threads, [thread.id]: value },
      ...(queue && (this.state.queues[thread.id]?.revision ?? -1) <= queue.revision
        ? { queues: { ...this.state.queues, [thread.id]: queue } }
        : {}),
      ...(interactions &&
      (this.state.interactions[thread.id]?.revision ?? -1) <= interactions.revision
        ? { interactions: { ...this.state.interactions, [thread.id]: interactions } }
        : {}),
    });
  }
  /** @param {string} threadId @param {CoreInteractions} value */
  setInteractions(threadId, value) {
    const old = this.state.interactions[threadId];
    if (old && old.revision > value.revision) return;
    this.publish({ interactions: { ...this.state.interactions, [threadId]: value } });
  }
  /** @param {string} threadId @param {CoreQueue} queue */
  setQueue(threadId, queue) {
    if (!Number.isSafeInteger(queue?.revision) || !Array.isArray(queue.items)) return;
    if ((this.state.queues[threadId]?.revision ?? -1) > queue.revision) return;
    this.publish({ queues: { ...this.state.queues, [threadId]: queue } });
  }
  /** @param {string} threadId @param {CoreGoals} value */
  setGoal(threadId, value) {
    const thread = this.state.threads[threadId];
    if (!thread || !Number.isSafeInteger(value?.revision)) return;
    const old = thread.goals;
    if (
      old &&
      (old.revision > value.revision ||
        (typeof old.eventSequence === "number" &&
          typeof value.eventSequence === "number" &&
          old.eventSequence > value.eventSequence))
    )
      return;
    this.replace({
      ...thread,
      goals: { revision: value.revision, eventSequence: value.eventSequence, goal: value.goal },
    });
  }
  /** @param {string} threadId @param {CorePlan} plan */
  setPlan(threadId, plan) {
    const thread = this.state.threads[threadId];
    if (!thread || !Number.isSafeInteger(plan?.revision) || !Array.isArray(plan.steps)) return;
    if ((thread.desktop?.plan?.revision ?? -1) > plan.revision) return;
    this.replace({ ...thread, desktop: { ...thread.desktop, plan } });
  }
  /** @param {CoreTask} task */
  setTask(task) {
    if (!task?.id || !Number.isSafeInteger(task.revision)) return;
    const old = this.state.tasks?.[task.id];
    if (
      old &&
      (old.revision > task.revision ||
        (typeof old.channelSequence === "number" &&
          typeof task.channelSequence === "number" &&
          old.channelSequence > task.channelSequence))
    )
      return;
    this.publish({ tasks: { ...this.state.tasks, [task.id]: task } });
  }
  /** @param {string} method @param {unknown} params */
  event(method, params) {
    if (!modelRecord(params)) return;
    if (method === "areal/task/updated") {
      if (isCoreTask(params.task)) this.setTask(params.task);
      return;
    }
    if (method === "areal/plan/updated") {
      if (typeof params.threadId === "string" && isCorePlan(params.plan))
        this.setPlan(params.threadId, params.plan);
      return;
    }
    if (method === "areal/goal/updated") {
      if (typeof params.threadId === "string" && isCoreGoals(params))
        this.setGoal(params.threadId, params);
      return;
    }
    if (method === "areal/queue/updated") {
      if (typeof params.threadId === "string" && isCoreQueue(params.queue))
        this.setQueue(params.threadId, params.queue);
      return;
    }
    if (method === "thread/started" || method === "areal/thread/edited") {
      if (isCoreThread(params.thread)) this.replace(params.thread);
      return;
    }
    if (method.startsWith("areal/interaction/")) {
      const item = params.interaction;
      if (!isCoreInteraction(item) || typeof params.revision !== "number") return;
      const old = this.state.interactions[item.threadId] ?? { revision: -1, data: [] };
      if (old.revision >= params.revision) return;
      this.setInteractions(item.threadId, {
        revision: params.revision,
        data: [...old.data.filter((entry) => entry.requestId !== item.requestId), item],
      });
      return;
    }
    if (typeof params.threadId !== "string") return;
    const thread = this.state.threads[params.threadId];
    if (!thread) return;
    if (method === "areal/thread/configured") {
      if (
        !modelRecord(params.configuration) ||
        !Array.isArray(params.modelChanges) ||
        !params.modelChanges.every(isCoreModelChange)
      )
        return;
      const previous = thread.desktop?.configuration;
      if (
        modelRecord(previous) &&
        typeof previous.revision === "number" &&
        typeof params.configuration.revision === "number" &&
        previous.revision > params.configuration.revision
      )
        return;
      this.replace({
        ...thread,
        desktop: {
          ...thread.desktop,
          configuration: params.configuration,
          modelChanges: params.modelChanges,
        },
      });
      return;
    }
    if (method === "areal/thread/predictionChanged") {
      this.replace({
        ...thread,
        desktop: { ...thread.desktop, promptPrediction: params.promptPrediction },
      });
      return;
    }
    if (
      method === "areal/side/capacity" &&
      thread.conversation?.kind === "side" &&
      (params.status === "waiting" || params.status === "available")
    ) {
      this.replace({
        ...thread,
        desktop: { ...thread.desktop, sideCapacityStatus: params.status },
      });
      return;
    }
    if (method === "areal/thread/tools/attached") {
      if (
        typeof params.toolsetRevision !== "number" ||
        !Number.isSafeInteger(params.toolsetRevision) ||
        params.toolsetRevision < 0 ||
        !Array.isArray(params.dynamicTools) ||
        params.toolsetRevision <= (thread.toolsetRevision ?? 0)
      )
        return;
      this.replace({
        ...thread,
        toolsetRevision: params.toolsetRevision,
        dynamicTools: params.dynamicTools,
      });
      return;
    }
    if (method === "areal/thread/archived") {
      this.replace({ ...thread, desktop: { ...thread.desktop, archived: true } });
      return;
    }
    if (method === "areal/thread/unarchived") {
      this.replace({ ...thread, desktop: { ...thread.desktop, archived: false } });
      return;
    }
    const turns = [...(thread.turns ?? [])];
    // Core 丢弃的是一次模型响应，不是整个 Turn；已执行工具与用户输入必须保留。
    if (method === "areal/model/completionDiscarded") {
      if (!Array.isArray(params.itemIds)) return;
      const discarded = new Set(params.itemIds);
      this.replace({
        ...thread,
        turns: turns.map((turn) => ({
          ...turn,
          items: (turn.items ?? []).filter((item) => !discarded.has(item.id)),
        })),
      });
      return;
    }
    if (method === "areal/context/compacted") {
      this.replace({
        ...thread,
        turns: turns.map((turn) =>
          turn.modelRetry?.purpose === "summary" ? { ...turn, modelRetry: undefined } : turn,
        ),
      });
      return;
    }
    if (method === "turn/started" || method === "turn/completed") {
      if (!isCoreTurn(params.turn)) return;
      const incoming = params.turn;
      const index = turns.findIndex((turn) => turn.id === incoming.id);
      if (index < 0) turns.push(params.turn);
      else {
        const old = turns[index];
        // 开始回执可能晚于流式事件，不能用旧文本覆盖已存在的轮次。
        if (params.turn.status === "inProgress") return;
        // 压缩后的 Turn 事件只带热历史尾部，省略条目不代表删除；完整读取才替换基线。
        const items = [...(old.items ?? [])];
        const positions = new Map(items.map((item, at) => [item.id, at]));
        for (const item of params.turn.items ?? []) {
          const at = positions.get(item.id);
          if (at === undefined) {
            positions.set(item.id, items.length);
            items.push(item);
          } else items[at] = item;
        }
        turns[index] = { ...old, ...params.turn, items, modelRetry: undefined };
      }
    } else {
      const index = turns.findIndex((turn) => turn.id === params.turnId);
      if (index < 0) return;
      const turn = { ...turns[index], items: [...(turns[index].items ?? [])] };
      if (method === "areal/turn/traceActivity") {
        const activity = params.activity;
        if (
          !modelRecord(activity) ||
          typeof activity.id !== "string" ||
          typeof activity.logicalId !== "string" ||
          !["model", "retryWait"].includes(String(activity.kind))
        )
          return;
        const trace = modelRecord(turn.trace) ? turn.trace : {};
        const activities = Array.isArray(trace.activities) ? [...trace.activities] : [];
        const at = activities.findIndex((entry) => modelRecord(entry) && entry.id === activity.id);
        if (at < 0) activities.push(activity);
        else activities[at] = activity;
        turn.trace = { ...trace, activities };
      } else if (method === "areal/model/watchdogRetry") {
        if (
          turn.status !== "inProgress" ||
          (params.purpose !== "solve" && params.purpose !== "summary") ||
          typeof params.retry !== "number" ||
          !Number.isSafeInteger(params.retry) ||
          params.retry < 1
        )
          return;
        turn.modelRetry = {
          purpose: params.purpose,
          retry: params.retry,
          ...(typeof params.delayMs === "number" ? { delayMs: params.delayMs } : {}),
        };
      } else if (
        method === "item/reasoning/textDelta" ||
        method === "item/reasoning/summaryTextDelta"
      ) {
        const summary = method === "item/reasoning/summaryTextDelta";
        const part = summary ? params.summaryIndex : params.contentIndex;
        const at = turn.items.findIndex(
          (item) => item.id === params.itemId && item.type === "reasoning",
        );
        if (
          at < 0 ||
          typeof part !== "number" ||
          !Number.isInteger(part) ||
          part < 0 ||
          part >= 64 ||
          typeof params.delta !== "string"
        )
          return;
        const field = summary ? "summary" : "content";
        const parts = [...(turn.items[at][field] ?? [])];
        while (parts.length <= part) parts.push("");
        parts[part] = `${parts[part]}${params.delta}`;
        turn.items[at] = { ...turn.items[at], [field]: parts };
        if (params.delta) turn.modelRetry = undefined;
      } else if (
        method === "item/started" ||
        method === "item/completed" ||
        method === "areal/item/agentMedia/available"
      ) {
        if (!isCoreItem(params.item)) return;
        const incoming = params.item;
        const at = turn.items.findIndex((item) => item.id === incoming.id);
        if (at < 0) turn.items.push(params.item);
        else turn.items[at] = params.item;
        if (
          params.item.type === "dynamicToolCall" ||
          params.item.type === "agentMedia" ||
          (params.item.type === "agentMessage" && params.item.text) ||
          (params.item.type === "reasoning" &&
            [...(params.item.summary ?? []), ...(params.item.content ?? [])].some(Boolean))
        ) {
          turn.modelRetry = undefined;
        }
      } else if (method === "item/agentMessage/delta") {
        if (typeof params.itemId !== "string" || typeof params.delta !== "string") return;
        if (params.delta) turn.modelRetry = undefined;
        const at = turn.items.findIndex((item) => item.id === params.itemId);
        if (at < 0)
          turn.items.push({ id: params.itemId, type: "agentMessage", text: params.delta });
        else
          turn.items[at] = {
            ...turn.items[at],
            text: `${turn.items[at].text ?? ""}${params.delta}`,
          };
      } else return;
      turns[index] = turn;
    }
    this.replace({ ...thread, turns });
  }
}
