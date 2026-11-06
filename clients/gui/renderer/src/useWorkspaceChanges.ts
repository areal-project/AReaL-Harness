import { useEffect, useRef, useState } from "react";
import { processItems, toolPresentation } from "./conversationPresentation.js";
import type { Action, Data } from "./services.js";

/**
 * 任务的分支与未暂存改动。读一次后保留结果，工具结算或手动刷新时在后台重读，
 * 摘要按钮和摘要卡共用这一份，打开卡片不再闪“正在读取”。
 */
export function useWorkspaceChanges(project: Data, thread: Data, action: Action) {
  const [git, setGit] = useState<Data>({ loading: true });
  const [revision, refresh] = useState(0);
  const request = useRef(action);
  request.current = action;
  const turn = thread.turns?.at(-1);
  const tools = processItems(turn?.items ?? [], turn?.status).filter(
    (item: Data) => item.type === "dynamicToolCall" && !item.processOwnerId,
  );
  const checkpoint = JSON.stringify([
    turn?.id,
    turn?.status,
    tools
      .filter((item: Data) => !toolPresentation(item).running && !item.processUnsettled)
      .map((item: Data) => item.id),
  ]);
  const connected = thread.executionConnected ?? !!project.state?.connected;
  useEffect(() => {
    if (!connected) return;
    let live = true;
    setGit((previous) => ({ ...previous, loading: true }));
    void (async () => {
      try {
        const info = await request.current("workspace", {
          projectId: project.id,
          threadId: thread.id,
          operation: "info",
        });
        const review =
          !("git" in info) && info.head
            ? await request.current("workspace", {
                projectId: project.id,
                threadId: thread.id,
                operation: "review",
                scope: "unstaged",
              })
            : undefined;
        if (live) setGit({ info, review });
      } catch (cause) {
        if (live) setGit({ error: (cause as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [project.id, thread.id, connected, checkpoint, revision]);
  const files: Data[] = git.review?.files ?? [];
  const total = (key: string) => files.reduce((sum, file) => sum + (file[key] ?? 0), 0);
  return {
    git,
    connected,
    files,
    additions: total("additions"),
    deletions: total("deletions"),
    refresh: () => refresh((value) => value + 1),
  };
}
export type WorkspaceChanges = ReturnType<typeof useWorkspaceChanges>;
