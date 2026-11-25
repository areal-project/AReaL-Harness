import { useCallback, useState } from "react";
import type { Data } from "../services.js";
import type { WorktreeSelection } from "../WorktreeStarter.js";

export type DraftEnvironment = "local" | "cloud";

export function useComposerWorkspace(project: Data | undefined) {
  const [worktreeSelections, setWorktreeSelections] = useState<
    Record<string, WorktreeSelection | undefined>
  >({});
  // 仅保存当前新建草稿的内存选择，不写入 localStorage；切项目、新建会话或打开会话自动回到本地，避免误拉起云端沙箱。
  const [draftEnvironmentState, setDraftEnvironmentState] = useState<
    { projectId: string; environment: DraftEnvironment } | undefined
  >();
  const worktreeSelection = project ? worktreeSelections[project.id] : undefined;
  const changeWorktreeSelection = (pid: string, value: WorktreeSelection | undefined) => {
    setWorktreeSelections((previous) => ({ ...previous, [pid]: value }));
  };
  const draftEnvironment: DraftEnvironment =
    project &&
    !project.projectless &&
    draftEnvironmentState &&
    draftEnvironmentState.projectId === project.id
      ? draftEnvironmentState.environment
      : "local";
  const changeDraftEnvironment = useCallback((pid: string, environment: DraftEnvironment) => {
    setDraftEnvironmentState(environment === "cloud" ? { projectId: pid, environment } : undefined);
  }, []);
  const resetDraftEnvironment = useCallback(() => {
    setDraftEnvironmentState(undefined);
  }, []);
  return {
    worktreeSelection,
    changeWorktreeSelection,
    draftEnvironment,
    changeDraftEnvironment,
    resetDraftEnvironment,
  };
}
