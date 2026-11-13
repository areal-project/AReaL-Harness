import { usePlatformReads } from "./PlatformReadContext.js";
import { currentErrorText } from "./errors/currentErrorText.js";
import { useEffect, useState } from "react";
import type { Action, Data } from "./services.js";

/** Project the target-owned frozen prefix into the same Turn shape as live history. */
export function useForkHistory(projectId: string, thread: Data, action: Action) {
  const reads = usePlatformReads();
  const snapshotId =
    thread.conversation?.kind === "fork" ? thread.conversation.historySeed?.snapshotId : undefined;
  // 重接同一分支会更换订阅；旧订阅上的失败不能阻止新订阅加载历史。
  const viewGeneration = thread.displayHistory?.viewGeneration;
  const owner = JSON.stringify([projectId, thread.id, snapshotId]);
  const [loaded, setLoaded] = useState<{ owner: string; turns: Data[]; error?: string }>();
  useEffect(() => {
    if (!snapshotId) return;
    let cancelled = false;
    const load = async () => {
      const turns = new Map<string, Data>();
      let cursor: string | undefined;
      let partial: { itemId: string; json: string } | undefined;
      const append = (entry: Data) => {
        const turn: Data = turns.get(entry.sourceTurnId) ?? {
          ...entry.turn,
          id: entry.sourceTurnId,
          status: entry.sourceTurnStatus,
          items: [],
        };
        turn.items.push({
          ...entry.item,
          historySource: {
            threadId: entry.sourceThreadId,
            turnId: entry.sourceTurnId,
            itemId: entry.sourceItemId,
          },
        });
        turns.set(entry.sourceTurnId, turn);
      };
      do {
        const page = reads
          ? await reads.history({
              view: "inherited",
              ...(cursor ? { cursor } : {}),
              maxBytes: 65536,
            })
          : await action("manage", {
              projectId,
              operation: "inheritedHistory",
              threadId: thread.id,
              view: "inherited",
              ...(cursor ? { cursor } : {}),
              maxBytes: 65536,
            });
        if (cancelled) return;
        if (page.snapshotId !== snapshotId) throw new Error("继承历史快照已变化");
        for (const entry of page.data ?? []) {
          if (!("fragment" in entry)) {
            if (partial) throw new Error("继承历史分片不连续");
            append(entry);
            continue;
          }
          const fragment = entry.fragment;
          if (!fragment) throw new Error("继承历史分片无效");
          const bytes = partial ? new TextEncoder().encode(partial.json).length : 0;
          if (fragment.offsetUtf8 !== bytes || (partial && partial.itemId !== entry.sourceItemId))
            throw new Error("继承历史分片不连续");
          const json = (partial?.json ?? "") + fragment.text;
          const total = new TextEncoder().encode(json).length;
          if (total > fragment.totalBytes) throw new Error("继承历史分片长度无效");
          if (total === fragment.totalBytes) {
            append(JSON.parse(json));
            partial = undefined;
          } else partial = { itemId: entry.sourceItemId, json };
        }
        if (page.complete) {
          if (partial) throw new Error("继承历史分片不完整");
          setLoaded({ owner, turns: [...turns.values()] });
          return;
        }
        if (!page.nextCursor || page.nextCursor === cursor) throw new Error("继承历史游标未推进");
        cursor = page.nextCursor;
      } while (!cancelled);
    };
    void load().catch((cause) => {
      if (!cancelled) setLoaded({ owner, turns: [], error: currentErrorText(cause) });
    });
    return () => {
      cancelled = true;
    };
  }, [action, reads, projectId, thread.id, snapshotId, owner, viewGeneration]);
  const current = loaded?.owner === owner ? loaded : undefined;
  return { turns: current?.turns ?? [], loading: !!snapshotId && !current, error: current?.error };
}
