import { useRef, useState } from "react";
import type { Data } from "../services.js";
import { confirmCloseFiles, workspaceDocumentOwner } from "../WorkspaceFilePane.js";
import type { useWorkspacePanels } from "./useWorkspacePanels.js";

export function useWorkspaceDocuments(
  project: Data | undefined,
  workspacePanels: ReturnType<typeof useWorkspacePanels>,
  rememberPanelTrigger: () => void,
) {
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const [reviewRequest, setReviewRequest] = useState<
    { owner: string; threadId?: string } & (
      | { turnId: string; scope?: never }
      | { scope: "unstaged"; turnId?: never }
    )
  >();
  const requestId = useRef(0);
  const locate = (target: string | { path: string; line?: number }, requestedLine?: number) => {
    const supplied = typeof target === "string" ? { path: target, line: requestedLine } : target;
    const { path, line } = supplied;
    return {
      owner: workspaceDocumentOwner(project?.id ?? "", project?.root ?? ""),
      path:
        project && path.startsWith(project.root + "/") ? path.slice(project.root.length + 1) : path,
      requestId: ++requestId.current,
      line: line && Number.isSafeInteger(line) && line > 0 ? line : undefined,
    };
  };
  const openFile = (target: string | { path: string; line?: number }, line?: number) => {
    rememberPanelTrigger();
    workspacePanels.openFile(
      locate(target, line),
      (previewPath) =>
        !!project &&
        !dirtyFiles[`${workspaceDocumentOwner(project.id, project.root)}:${previewPath}`] &&
        confirmCloseFiles(project.id, [previewPath], project.root),
    );
  };
  return {
    dirtyFiles,
    reviewRequest,
    openFile,
    revealFile: (path: string) => workspacePanels.revealFile(locate(path)),
    requestReview: (request: NonNullable<typeof reviewRequest>) => setReviewRequest(request),
    markDirty(projectId: string, root: string, path: string, dirty: boolean) {
      setDirtyFiles((current) => ({
        ...current,
        [`${workspaceDocumentOwner(projectId, root)}:${path}`]: dirty,
      }));
      if (dirty) workspacePanels.keepFile(`file:${path}`);
    },
    forgetClosed(projectId: string, root: string, paths: string[]) {
      setDirtyFiles((current) => {
        const next = { ...current };
        for (const path of paths) delete next[`${workspaceDocumentOwner(projectId, root)}:${path}`];
        return next;
      });
    },
  };
}
