// Adapted from ZCode WorkspaceFileTreeRowView: row composition and drag contract.
// Platform actions are supplied by AReaL; no ZCode service/store is imported.
import type { CSSProperties, KeyboardEvent } from "react";
import { MessageCopy as Copy, ReviewCommentGlyph as MessageSquarePlus } from "../interfaceIcons.js";
import { WorkspaceFileIcon, WorkspaceDirectoryChevron } from "./WorkspaceFileIcon.js";
import { cn } from "../components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.js";
import { WorkspaceFileTreeRowName } from "./WorkspaceFileTreeRowName.js";
import {
  dispatchWorkspaceFileAddToChat,
  dispatchWorkspaceFileDragState,
  serializeWorkspaceFileDragPayload,
  WORKSPACE_FILE_DRAG_MIME,
} from "../lib/workspaceFileDrag.js";
import { buildFileMentionMarkdown } from "../mentions/mentionMarkdown.js";
export interface FileRow {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  expanded?: boolean;
  status?: string;
}
export function WorkspaceFileTreeRowView({
  row,
  root,
  selected,
  onOpen,
  onToggle,
  onKeyDown,
  onError,
}: {
  row: FileRow;
  root: string;
  selected: boolean;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: FileRow) => void;
  onError: (message: string) => void;
}) {
  const statusColor = (
    {
      A: "text-git-added",
      U: "text-git-untracked",
      M: "text-git-modified",
      D: "text-git-deleted",
      R: "text-git-renamed",
      C: "text-warning",
    } as Record<string, string>
  )[row.status ?? ""];
  const payload = {
    type: row.dir ? ("directory" as const) : ("file" as const),
    workspacePath: root,
    path: `${root}/${row.path}`,
    relativePath: row.path,
    name: row.name,
  };
  const copy = (path: string) =>
    void navigator.clipboard.writeText(path).catch((e) => onError(e.message));
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            role="treeitem"
            aria-label={row.path}
            aria-selected={selected}
            aria-expanded={row.dir ? row.expanded : undefined}
            tabIndex={0}
            draggable
            title={row.path}
            data-file-path={row.path}
            style={{ "--workspace-file-tree-depth": row.depth } as CSSProperties}
            className="workspace-file-tree-row review-file-tree-row cursor-pointer"
            onClick={(e) => {
              if (e.detail > 1) return;
              row.dir ? onToggle(row.path) : row.status !== "D" && onOpen(row.path);
            }}
            onKeyDown={(e) => onKeyDown(e, row)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(
                WORKSPACE_FILE_DRAG_MIME,
                serializeWorkspaceFileDragPayload(payload),
              );
              event.dataTransfer.setData(
                "text/plain",
                buildFileMentionMarkdown(row.path, row.name, payload.type),
              );
              dispatchWorkspaceFileDragState(true);
            }}
            onDragEnd={() => dispatchWorkspaceFileDragState(false)}
          >
            {row.dir && <span className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle"><WorkspaceDirectoryChevron expanded={row.expanded} /></span>}
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {!row.dir && (
                <WorkspaceFileIcon path={row.path} />
              )}
              <WorkspaceFileTreeRowName
                name={row.name}
                className="min-w-0 flex-1 truncate"
                slashClassName="mx-1 text-foreground-subtlest"
              />
            </span>
            {row.status && (
              <span
                className={cn("shrink-0 font-mono text-ui-base font-bold", statusColor)}
                aria-label={
                  {
                    A: "新增",
                    M: "已修改",
                    D: "已删除",
                    R: "已重命名",
                    U: "未跟踪",
                    C: "存在冲突",
                  }[row.status]
                }
              >
                {row.dir ? "●" : row.status}
              </span>
            )}
          </div>
        }
      />
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={() => copy(payload.path)}>
          <Copy className="size-4" />
          复制绝对路径
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copy(row.path)}>
          <Copy className="size-4" />
          复制相对路径
        </ContextMenuItem>
        <ContextMenuItem onClick={() => dispatchWorkspaceFileAddToChat(payload)}>
          <MessageSquarePlus className="size-4" />
          添加到对话
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
