/** 可重建的客户端投影；不持久化执行事实，不依赖 React 或平台模块。 */
export class CoreTaskModel {
  constructor() {
    this.state = { connected: false, threads: {}, interactions: {}, queues: {}, error: null };
    this.listeners = new Set();
  }

  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.state;
  publish(patch = {}) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  connection(connected, error = null) { this.publish({ connected, error }); }
  replace(thread) {
    const old = this.state.threads[thread.id];
    // A snapshot requested before an attachment may arrive after its committed event.
    const currentRevision = old?.toolsetRevision ?? 0;
    const incomingRevision = thread.toolsetRevision ?? 0;
    const value = currentRevision > incomingRevision
      ? { ...thread, dynamicTools: old.dynamicTools, toolsetRevision: currentRevision }
      : thread;
    this.publish({ threads: { ...this.state.threads, [thread.id]: value } });
  }
  setInteractions(threadId, value) {
    const old = this.state.interactions[threadId];
    if (old && old.revision > value.revision) return;
    this.publish({ interactions: { ...this.state.interactions, [threadId]: value } });
  }
  setQueue(threadId, queue) {
    if (!Number.isSafeInteger(queue?.revision) || !Array.isArray(queue.items)) return;
    if ((this.state.queues[threadId]?.revision ?? -1) > queue.revision) return;
    this.publish({ queues: { ...this.state.queues, [threadId]: queue } });
  }
  setGoal(threadId, value) {
    const thread = this.state.threads[threadId];
    if (!thread || !Number.isSafeInteger(value?.revision)) return;
    const old = thread.goals;
    if (old && (old.revision > value.revision || old.eventSequence > value.eventSequence)) return;
    this.replace({ ...thread, goals: { revision: value.revision, eventSequence: value.eventSequence, goal: value.goal } });
  }
  setPlan(threadId, plan) {
    const thread = this.state.threads[threadId];
    if (!thread || !Number.isSafeInteger(plan?.revision) || !Array.isArray(plan.steps)) return;
    if ((thread.desktop?.plan?.revision ?? -1) > plan.revision) return;
    this.replace({ ...thread, desktop: { ...thread.desktop, plan } });
  }
  setTask(task) {
    if (!task?.id || !Number.isSafeInteger(task.revision)) return;
    const old = this.state.tasks?.[task.id];
    if (old && (old.revision > task.revision || old.channelSequence > task.channelSequence)) return;
    this.publish({ tasks: { ...this.state.tasks, [task.id]: task } });
  }
  event(method, params) {
    if (method === 'areal/task/updated') { this.setTask(params.task); return; }
    if (method === 'areal/plan/updated') { this.setPlan(params.threadId, params.plan); return; }
    if (method === 'areal/goal/updated') { this.setGoal(params.threadId, params); return; }
    if (method === 'areal/queue/updated') { this.setQueue(params.threadId, params.queue); return; }
    if (method === 'thread/started') { this.replace(params.thread); return; }
    if (method.startsWith('areal/interaction/')) {
      const item = params.interaction;
      if (!item) return;
      const old = this.state.interactions[item.threadId] ?? { revision: -1, data: [] };
      if (old.revision >= params.revision) return;
      this.setInteractions(item.threadId, { revision: params.revision,
        data: [...old.data.filter(entry => entry.requestId !== item.requestId), item] });
      return;
    }
    const thread = this.state.threads[params?.threadId];
    if (!thread) return;
    if (method === 'areal/side/capacity' && thread.conversation?.kind === 'side'
      && ['waiting', 'available'].includes(params.status)) {
      this.replace({ ...thread, desktop: { ...thread.desktop, sideCapacityStatus: params.status } });
      return;
    }
    if (method === 'areal/thread/tools/attached') {
      if (!Number.isSafeInteger(params.toolsetRevision) || params.toolsetRevision < 0
        || !Array.isArray(params.dynamicTools) || params.toolsetRevision <= (thread.toolsetRevision ?? 0)) return;
      this.replace({ ...thread, toolsetRevision: params.toolsetRevision, dynamicTools: params.dynamicTools });
      return;
    }
    if (method === 'areal/thread/archived') { this.replace({ ...thread, desktop: { ...thread.desktop, archived: true } }); return; }
    if (method === 'areal/thread/unarchived') { this.replace({ ...thread, desktop: { ...thread.desktop, archived: false } }); return; }
    const turns = [...thread.turns ?? []];
    // Core 丢弃的是一次模型响应，不是整个 Turn；已执行工具与用户输入必须保留。
    if (method === 'areal/model/completionDiscarded') {
      if (!Array.isArray(params.itemIds)) return;
      const discarded = new Set(params.itemIds);
      this.replace({ ...thread, turns: turns.map(turn => ({ ...turn,
        items: (turn.items ?? []).filter(item => !discarded.has(item.id)),
      })) });
      return;
    }
    if (method === 'areal/context/compacted') {
      this.replace({ ...thread, turns: turns.map(turn => turn.modelRetry?.purpose === 'summary'
        ? { ...turn, modelRetry: undefined } : turn) });
      return;
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const index = turns.findIndex(turn => turn.id === params.turn.id);
      if (index < 0) turns.push(params.turn);
      else turns[index] = { ...turns[index], ...params.turn, modelRetry: undefined };
    } else {
      const index = turns.findIndex(turn => turn.id === params.turnId);
      if (index < 0) return;
      const turn = { ...turns[index], items: [...turns[index].items ?? []] };
      if (method === 'areal/model/watchdogRetry') {
        if (turn.status !== 'inProgress' || !['solve', 'summary'].includes(params.purpose)
          || !Number.isSafeInteger(params.retry) || params.retry < 1) return;
        turn.modelRetry = { purpose: params.purpose, retry: params.retry };
      } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
        const summary = method === 'item/reasoning/summaryTextDelta';
        const part = summary ? params.summaryIndex : params.contentIndex;
        const at = turn.items.findIndex(item => item.id === params.itemId && item.type === 'reasoning');
        if (at < 0 || !Number.isInteger(part) || part < 0 || part >= 64 || typeof params.delta !== 'string') return;
        const field = summary ? 'summary' : 'content';
        const parts = [...turn.items[at][field] ?? []];
        while (parts.length <= part) parts.push('');
        parts[part] += params.delta;
        turn.items[at] = { ...turn.items[at], [field]: parts };
        if (params.delta) turn.modelRetry = undefined;
      } else if (method === 'item/started' || method === 'item/completed' || method === 'areal/item/agentMedia/available') {
        const at = turn.items.findIndex(item => item.id === params.item.id);
        if (at < 0) turn.items.push(params.item);
        else turn.items[at] = params.item;
        if (params.item.type === 'dynamicToolCall' || params.item.type === 'agentMedia'
          || (params.item.type === 'agentMessage' && params.item.text)
          || (params.item.type === 'reasoning' && [...params.item.summary ?? [], ...params.item.content ?? []].some(Boolean))) {
          turn.modelRetry = undefined;
        }
      } else if (method === 'item/agentMessage/delta') {
        if (params.delta) turn.modelRetry = undefined;
        const at = turn.items.findIndex(item => item.id === params.itemId);
        if (at < 0) turn.items.push({ id: params.itemId, type: 'agentMessage', text: params.delta });
        else turn.items[at] = { ...turn.items[at], text: (turn.items[at].text ?? '') + params.delta };
      } else return;
      turns[index] = turn;
    }
    this.replace({ ...thread, turns });
  }
}
