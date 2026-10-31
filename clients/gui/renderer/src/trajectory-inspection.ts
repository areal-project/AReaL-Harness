import { trajectoryText } from "./trajectory.js";
import type { Action, Data } from "./services.js";

export type TraceNode = {
  target?: { threadId: string; executionId?: string; workerThreadId?: string };
  threadId: string;
  title: string;
  parentThreadId?: string;
  turns: Data[];
  children: { execution: Data; nodes: TraceNode[]; error?: string }[];
  queue?: Data;
  readAtMs: number;
  stateConfirmed?: boolean;
  errors: string[];
};
type Target = { threadId: string; executionId?: string; workerThreadId?: string };

/** 分页与分片使用 Core 自有历史游标；读视图不发出执行命令。 */
export async function loadTraceTree(
  action: Action,
  projectId: string,
  threadId: string,
  signal: AbortSignal,
  previous?: TraceNode,
): Promise<TraceNode> {
  const visited = new Set<string>();
  const read = (target: Target, cursor?: string): Promise<Data> =>
    action("manage", {
      projectId,
      operation: "executionTrace",
      ...target,
      ...(cursor ? { cursor } : {}),
    });
  const check = () => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const load = async (target: Target, old?: TraceNode, initial?: Data): Promise<TraceNode> => {
    check();
    const first = initial ?? (await read(target));
    check();
    const node: TraceNode = {
      target,
      threadId: first.threadId,
      title: first.title,
      parentThreadId: first.parentThreadId,
      turns: [],
      children: [],
      queue: first.queue,
      readAtMs: first.readAtMs,
      errors:
        first.stateConfirmed === false
          ? ["执行当前状态待确认 / Current execution state is unconfirmed"]
          : [],
      stateConfirmed: first.stateConfirmed,
    };
    if (visited.has(node.threadId))
      return { ...node, errors: ["重复的会话引用 / Repeated conversation reference"] };
    visited.add(node.threadId);
    const entries: Data[][] = [];
    const known = new Set(
      old?.turns
        .filter((t) => t.status !== "inProgress")
        .flatMap((t) => t.items.map((i: Data) => i.id)) ?? [],
    );
    let page = first.page;
    const cursors = new Set<string>();
    while (page) {
      check();
      const batch: Data[] = [];
      for (const entry of page.data ?? []) {
        if (entry.item?.type !== "historyDeferred") {
          batch.push(entry);
          continue;
        }
        const fragments: string[] = [];
        let cursor: string | undefined = entry.item.cursor;
        let offset = 0;
        while (cursor) {
          check();
          const value = await read(target, cursor);
          const fragment = value.page.data[0]?.fragment;
          if (
            !fragment ||
            fragment.offsetUtf8 !== offset ||
            fragment.version !== entry.item.version
          )
            throw new Error("历史内容已变化，请刷新 / History changed; refresh the trace");
          fragments.push(fragment.text);
          offset = fragment.nextOffsetUtf8;
          cursor = value.page.nextCursor ?? undefined;
        }
        batch.push(JSON.parse(fragments.join("")));
      }
      entries.unshift(batch);
      if (!page.nextCursor) {
        if (!page.complete) throw new Error("历史读取范围不完整 / Incomplete history coverage");
        break;
      }
      if (old && batch.some((e) => known.has(e.sourceItemId))) break;
      if (cursors.has(page.nextCursor)) throw new Error("历史游标重复 / Repeated history cursor");
      cursors.add(page.nextCursor);
      page = (await read(target, page.nextCursor)).page;
    }
    const turns = new Map<string, Data>(
      (old?.turns ?? [])
        .filter((t) => t.status !== "inProgress")
        .map((t) => [t.id, { ...t, items: [...t.items] }]),
    );
    for (const entry of entries.flat()) {
      const turn = turns.get(entry.sourceTurnId) ?? {
        ...entry.turn,
        id: entry.sourceTurnId,
        items: [],
      };
      const items = new Map<string, Data>(turn.items.map((i: Data) => [i.id, i]));
      items.set(entry.sourceItemId, entry.item);
      turns.set(turn.id, { ...turn, ...entry.turn, items: [...items.values()] });
    }
    if (first.activeTurn) {
      const active = first.activeTurn;
      turns.set(active.id, active);
    }
    node.turns = [...turns.values()].sort(
      (a, b) =>
        (a.trace?.startedAtMs ?? (a.startedAt ?? 0) * 1000) -
        (b.trace?.startedAtMs ?? (b.startedAt ?? 0) * 1000),
    );
    const executions: Data[] = [...(first.executions?.data ?? [])];
    let offset = first.executions?.nextOffset;
    while (offset != null) {
      check();
      const more: Data = await action("manage", {
        projectId,
        operation: "executions",
        parentThreadId: node.threadId,
        offset,
        limit: 100,
      });
      executions.push(...more.data);
      if (more.nextOffset === offset)
        throw new Error("执行分页未推进 / Execution page did not advance");
      offset = more.nextOffset;
    }
    for (const execution of executions) {
      check();
      const child: TraceNode["children"][number] = { execution, nodes: [] };
      const oldChild = old?.children.find((c) => c.execution.executionId === execution.executionId);
      try {
        const childTarget = { threadId: node.threadId, executionId: execution.executionId };
        const value = await read(childTarget);
        const sources: Data[] = value.sources?.length
          ? value.sources
          : [{ threadId: value.threadId }];
        for (const source of sources) {
          const selected = {
            ...childTarget,
            ...(value.sources?.length ? { workerThreadId: source.threadId } : {}),
          };
          child.nodes.push(
            await load(
              selected,
              oldChild?.nodes.find((n) => n.threadId === source.threadId),
              source.threadId === value.threadId ? value : undefined,
            ),
          );
        }
      } catch (error) {
        check();
        child.nodes = (oldChild?.nodes ?? []).map((n) => ({
          ...n,
          errors: [...n.errors, String(error)],
        }));
        child.error = error instanceof Error ? error.message : String(error);
      }
      node.children.push(child);
    }
    for (const source of first.legacySources ?? []) {
      check();
      const execution = {
        threadId: source.threadId,
        executionId: `legacy:${source.threadId}`,
        title: source.title,
        status: "unknown",
      };
      const child: TraceNode["children"][number] = { execution, nodes: [] };
      try {
        const oldNode = old?.children.find((c) => c.execution.executionId === execution.executionId)
          ?.nodes[0];
        const value = await load({ threadId: source.threadId }, oldNode);
        execution.status = value.turns.at(-1)?.status ?? "unknown";
        child.nodes.push(value);
      } catch (cause) {
        check();
        child.error = cause instanceof Error ? cause.message : String(cause);
      }
      node.children.push(child);
    }
    return node;
  };
  return load({ threadId }, previous);
}

export function traceDuration(turn: Data, now: number): number | undefined {
  if (typeof turn.durationMs === "number") return turn.durationMs;
  if (turn.status === "inProgress" && typeof turn.trace?.startedAtMs === "number")
    return Math.max(0, now - turn.trace.startedAtMs);
  return undefined;
}
export function activityDuration(
  entry: { durationMs?: number; startedAtMs?: number; status?: string },
  turn: Data,
  now: number,
): number | undefined {
  if (typeof entry.durationMs === "number") return entry.durationMs;
  if (turn.status === "inProgress" && entry.status === "running" && entry.startedAtMs != null)
    return Math.max(0, now - entry.startedAtMs);
  return undefined;
}
export function traceNodes(root: TraceNode): TraceNode[] {
  return [root, ...root.children.flatMap((c) => c.nodes.flatMap(traceNodes))];
}
export function traceCoverage(root: TraceNode): string[] {
  return traceNodes(root).flatMap((n) => [
    ...n.errors,
    ...n.children.flatMap((c) => (c.error ? [`${c.execution.title}: ${c.error}`] : [])),
  ]);
}

export function traceCreationTurn(node: TraceNode, execution: Data): string | undefined {
  return (
    execution.owner?.turnId ??
    node.turns.find((turn) => turn.items.some((item: Data) => item.callId === execution.requestId))
      ?.id
  );
}
export function traceReferences(node: TraceNode, item: Data): string[] {
  const args = item.arguments ?? {};
  const executions = new Set([
    args.executionId,
    ...(Array.isArray(args.executionIds) ? args.executionIds : []),
  ]);
  const threads = new Set([
    args.threadId,
    ...(Array.isArray(args.threadIds) ? args.threadIds : []),
  ]);
  return node.children
    .filter(
      (child) =>
        executions.has(child.execution.executionId) ||
        (child.execution.threadId && threads.has(child.execution.threadId)),
    )
    .map((child) => child.execution.executionId);
}

export function copyTrace(
  root: TraceNode,
  title: string,
  turnId?: string,
  readErrors: string[] = [],
) {
  const include = (node: TraceNode, selectedTurn?: string): Data => {
    const turns = node.turns.filter((t) => !selectedTurn || t.id === selectedTurn);
    const children = node.children.filter(
      (child) =>
        !selectedTurn ||
        traceCreationTurn(node, child.execution) === selectedTurn ||
        turns.some((turn) =>
          turn.items.some((item: Data) =>
            traceReferences(node, item).includes(child.execution.executionId),
          ),
        ),
    );
    const coverage = [
      ...node.errors,
      ...children.flatMap((child) => [
        ...(child.error ? [child.error] : []),
        ...child.nodes.flatMap(traceCoverage),
      ]),
    ];
    if (selectedTurn && node.children.some((child) => !traceCreationTurn(node, child.execution)))
      coverage.push(
        "部分子代理属于任务或未记录创建轮次 / Some agents are task-owned or lack a recorded creation turn",
      );
    return {
      ...JSON.parse(
        trajectoryText({ id: node.threadId, parentThreadId: node.parentThreadId, turns }, title),
      ),
      readAtMs: node.readAtMs,
      stateConfirmed: node.stateConfirmed,
      coverage,
      children: children.map((c) => ({
        execution: c.execution,
        error: c.error,
        sources: c.nodes.map((n) => include(n)),
      })),
    };
  };
  const value = include(root, turnId);
  return JSON.stringify(
    {
      scope: turnId ? "turnIncludingSubagents" : "conversationIncludingSubagents",
      ...value,
      coverage: [...new Set([...value.coverage, ...readErrors])],
    },
    null,
    2,
  );
}
