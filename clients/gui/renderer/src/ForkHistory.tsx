import { useEffect, useState } from "react";
import type { Action, Data } from "./services.js";

/** Project the target-owned frozen prefix into the same Turn shape as live history. */
export function useForkHistory(projectId: string, thread: Data, action: Action) {
  const snapshotId = thread.conversation?.kind === "fork" ? thread.conversation.historySeed?.snapshotId : undefined;
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
          ...entry.turn, id: entry.sourceTurnId, status: entry.sourceTurnStatus, items: []
        };
        turn.items.push(entry.item);
        turns.set(entry.sourceTurnId, turn);
      };
      do {
        const page = await action("manage", { projectId, operation: "inheritedHistory", threadId: thread.id,
          view: "inherited", ...(cursor ? { cursor } : {}), maxBytes: 65536 });
        if (cancelled) return;
        if (page.snapshotId !== snapshotId) throw new Error("继承历史快照已变化");
        for (const entry of page.data ?? []) {
          if (!entry.fragment) {
            if (partial) throw new Error("继承历史分片不连续");
            append(entry); continue;
          }
          const fragment = entry.fragment;
          const bytes = partial ? new TextEncoder().encode(partial.json).length : 0;
          if (fragment.offsetUtf8 !== bytes || partial && partial.itemId !== entry.sourceItemId) throw new Error("继承历史分片不连续");
          const json = (partial?.json ?? "") + fragment.text;
          const total = new TextEncoder().encode(json).length;
          if (total > fragment.totalBytes) throw new Error("继承历史分片长度无效");
          if (total === fragment.totalBytes) { append(JSON.parse(json)); partial = undefined; }
          else partial = { itemId: entry.sourceItemId, json };
        }
        if (page.complete) {
          if (partial) throw new Error("继承历史分片不完整");
          setLoaded({ owner, turns: [...turns.values()] }); return;
        }
        if (!page.nextCursor || page.nextCursor === cursor) throw new Error("继承历史游标未推进");
        cursor = page.nextCursor;
      } while (!cancelled);
    };
    void load().catch(cause => { if (!cancelled) setLoaded({ owner, turns: [], error: cause.message }); });
    return () => { cancelled = true; };
  }, [action, projectId, thread.id, snapshotId, owner]);
  const current = loaded?.owner === owner ? loaded : undefined;
  return { turns: current?.turns ?? [], loading: !!snapshotId && !current, error: current?.error };
}
