import { useState } from "react";
import type { Data } from "../services.js";
import type { WorktreeSelection } from "../WorktreeStarter.js";

export function useComposerWorkspace(project: Data | undefined) {
  const [worktreeSelections, setWorktreeSelections] = useState<
    Record<string, WorktreeSelection | undefined>
  >({});
  const worktreeSelection = project ? worktreeSelections[project.id] : undefined;
  const changeWorktreeSelection = (pid: string, value: WorktreeSelection | undefined) => {
    setWorktreeSelections((previous) => ({ ...previous, [pid]: value }));
  };
  return {
    worktreeSelection,
    changeWorktreeSelection,
  };
}
