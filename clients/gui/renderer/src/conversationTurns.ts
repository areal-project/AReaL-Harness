import { memo, useRef, type ReactNode } from "react";
import type { Data } from "./services.js";

const merged = new WeakMap<Data, { topology: string; turn: Data }>();

/** 把分页拓扑里的省略项与缺页提示并入本地轮次；投影保留未变轮次的引用，按轮次缓存后旧轮次不重算。 */
export function withHistoryTopology(localThread: Data): Data[] {
  const pages: Data[] | undefined = localThread.displayHistory?.pageTopology;
  const gaps: Data[] | undefined = localThread.displayHistory?.gaps;
  // 线程头随每个增量重建，拓扑按内容比较。
  const topology = JSON.stringify([pages, gaps]);
  return (localThread.turns ?? []).map((turn: Data) => {
    const cached = merged.get(turn);
    if (cached?.topology === topology) return cached.turn;
    const result = mergeTurn(turn, pages ?? [], gaps ?? []);
    merged.set(turn, { topology, turn: result });
    return result;
  });
}

function mergeTurn(turn: Data, pages: Data[], gaps: Data[]): Data {
  const items: Data[] = turn.items ?? [];
  const records: Data[] = [...pages]
    .reverse()
    .flatMap((page: Data) => page.items.filter((item: Data) => item.turnId === turn.id));
  const known = new Set(records.map((item) => item.itemId));
  const shown = new Map(items.map((item) => [item.id, item]));
  const topology = records.flatMap((record) => {
    if (shown.has(record.itemId)) return [shown.get(record.itemId)!];
    const slot = {
      id: record.itemId,
      type: record.type,
      phase: record.phase,
      historyActivityBreak: record.activityBreak,
      historyOmitted: true,
    };
    return record.answers
      ? [
          slot,
          { id: `question-answer:${record.itemId}`, type: "questionAnswer", historyOmitted: true },
        ]
      : record.visible === false
        ? []
        : [slot];
  });
  const ordered: Data[] = [];
  let cursor = 0;
  for (const item of items) {
    if (known.has(item.id)) {
      const index = topology.findIndex((entry) => entry.id === item.id);
      while (cursor < index) ordered.push(topology[cursor++]);
      cursor = Math.max(cursor, index + 1);
    }
    ordered.push(item);
  }
  ordered.push(...topology.slice(cursor).filter((item) => !shown.has(item.id)));
  return {
    ...turn,
    items: ordered.flatMap((item) => [
      ...gaps
        .filter((gap: Data) => gap.beforeItemId === item.id)
        .map((gap: Data) => ({
          ...gap,
          type: "historyPageGap",
          topologyKnown: gap.topologyKnown === true,
        })),
      item,
    ]),
  };
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: unknown) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return String(value);
  let id = identities.get(value);
  if (id === undefined) identities.set(value, (id = ++nextIdentity));
  return id;
}

/**
 * 旧轮次重渲染的条件：轮次本身或它读取的会话上下文变了。项目头、线程头按内容比较
 * （投影每个增量都会重建它们）；其他线程按引用比较，当前线程的轮次由各轮自己比较。
 */
export { identity as turnIdentity };
export function turnContextStamp(project: Data, localThread: Data, extra: unknown[], live: object) {
  const { turns: _turns, ...threadHead } = localThread;
  const { state, ...projectHead } = project;
  const { threads, ...stateHead } = state ?? {};
  const others = Object.values((threads ?? {}) as Record<string, Data>)
    .filter((thread) => thread.id !== localThread.id)
    .map(identity);
  return JSON.stringify([projectHead, stateHead, threadHead, others, extra, Object.keys(live)]);
}

/** 函数在跳过渲染的旧轮次里仍调用最新版本；只在有无变化时改变引用。 */
export function useLiveFunctions<T extends Record<string, unknown>>(functions: T): T {
  const current = useRef(functions);
  current.current = functions;
  const wrappers = useRef(new Map<string, unknown>());
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(functions)) {
    if (typeof functions[key] !== "function") continue;
    if (!wrappers.current.has(key))
      wrappers.current.set(key, (...args: unknown[]) =>
        (current.current[key] as (...args: unknown[]) => unknown)(...args),
      );
    result[key] = wrappers.current.get(key);
  }
  return result as T;
}

/** 轮次与上下文戳都没变时复用上次的渲染结果；render 每次都是最新闭包。 */
export const MemoTurn = memo(
  ({ render }: { turn: Data; stamp: string; render: () => ReactNode }) => render(),
  (previous, next) => previous.turn === next.turn && previous.stamp === next.stamp,
);
