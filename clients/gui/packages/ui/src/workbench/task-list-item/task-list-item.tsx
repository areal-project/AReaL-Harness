import { TitleTooltip } from "../../components/tooltip/tooltip.js";
/* Adapted from ZCode 872ad960 TaskListItem.tsx: original default row markup,
 * title overflow and action geometry. Core supplies state and callbacks. */
import { memo, type ReactNode, type ComponentProps } from "react";
import { Cloud, LoaderIcon, CircleDashed, GitFork } from "lucide-react";
import {
  ArchiveChatIcon as Archive,
  PinChatIcon as Pin,
  MoreOptionsIcon as MoreHorizontal,
} from "../../icons.js";
import { cn } from "../../lib/utils.js";
import { TaskTitleOverflowText } from "../task-title-overflow/task-title-overflow.js";
import { Button } from "../../components/button/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu/dropdown-menu.js";
import { HoverActions } from "../../components/hover-actions/hover-actions.js";
export type TaskListItemLabels = {
  statePendingTooltip?: string;
  statePending?: string;
  running?: string;
  attention?: string;
  unread?: string;
  pin?: string;
  unpin?: string;
  archive?: string;
  rename?: string;
  moreActions?: (title: string) => string;
  pinAction?: (title: string, pinned: boolean) => string;
  archiveAction?: (title: string) => string;
};

export const MemoTaskItem = memo(function TaskListItem({
  id,
  title,
  worktree,
  cloud = false,
  active,
  pinned,
  running,
  attention,
  archived,
  disabled,
  unread = false,
  statePending = false,
  nested = true,
  instanceId,
  renderSurface,
  reducedMotion = false,
  worktreeLabel,
  worktreeTitle,
  cloudLabel,
  cloudTitle,
  organizationActions,
  readOnly = false,
  labels,
  onSelect,
  onRename,
  onPin,
  onArchive,
}: {
  id: string;
  title: string;
  worktree?: { branch: string; directory: string; state?: string };
  cloud?: boolean;
  active: boolean;
  pinned: boolean;
  running: boolean;
  attention: boolean;
  archived: boolean;
  disabled: boolean;
  unread?: boolean;
  statePending?: boolean;
  nested?: boolean;
  instanceId?: string;
  renderSurface?: (props: ComponentProps<"li">) => ReactNode;
  reducedMotion?: boolean;
  worktreeLabel?: string;
  worktreeTitle?: string;
  cloudLabel?: string;
  cloudTitle?: string;
  organizationActions?: ReactNode;
  readOnly?: boolean;
  labels?: TaskListItemLabels;
  onSelect: () => void;
  onRename: () => void;
  onPin: () => void;
  onArchive?: () => void;
}) {
  const pinLabel = labels?.pin ?? "置顶";
  const unpinLabel = labels?.unpin ?? "取消置顶";
  const archiveLabel = labels?.archive ?? "归档";
  const renameLabel = labels?.rename ?? "重命名";
  const surface = (
    <li
      data-task-item-key={instanceId ? undefined : id}
      data-thread-id={id}
      data-task-view={nested ? "tree" : "flat"}
      data-testid={`${instanceId ? "recent-task-item" : "task-item"}-${id}`}
      data-unread={unread}
      data-state-pending={statePending}
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group/task-item navigation-task-row relative flex cursor-pointer gap-2 transition-[background-color,border-color,box-shadow] items-center",
      )}
    >
      {(nested || pinned || statePending || running || attention || unread || archived) && (
        <div className="relative flex size-4 shrink-0 items-center justify-center">
          {statePending ? (
            <TitleTooltip title={labels?.statePendingTooltip ?? "打开任务以更新状态"}>
              <span role="img" aria-label={labels?.statePending ?? "状态待更新"}>
                <CircleDashed className="size-3.5 text-foreground-subtle" />
              </span>
            </TitleTooltip>
          ) : running ? (
            <LoaderIcon
              role="img"
              aria-label={labels?.running ?? "运行中"}
              className="size-4 animate-spin motion-reduce:animate-none text-foreground-subtle"
            />
          ) : attention ? (
            <span
              className="size-1.5 rounded-full bg-warning"
              role="img"
              aria-label={labels?.attention ?? "等待处理"}
            />
          ) : unread ? (
            <span
              className="size-1.5 rounded-full bg-primary"
              role="img"
              aria-label={labels?.unread ?? "未读"}
            />
          ) : pinned ? (
            <Pin className="size-3.5 text-foreground-subtle" />
          ) : archived ? (
            <Archive className="size-3.5 text-foreground-subtle" />
          ) : null}
        </div>
      )}
      <div className="task-row-title flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative min-w-0 flex flex-1 items-center gap-1.5">
            <TaskTitleOverflowText
              reducedMotion={reducedMotion}
              className="navigation-task-title"
              title={title}
            >
              {title}
            </TaskTitleOverflowText>
          </div>
        </div>
      </div>
      {worktree && (
        <TitleTooltip title={worktreeTitle}>
          <span
            data-testid="task-worktree-badge"
            className="task-worktree-badge shrink-0 text-foreground-subtle"
            aria-label={worktreeLabel}
          >
            <GitFork className="size-3.5" aria-hidden="true" />
          </span>
        </TitleTooltip>
      )}
      {!worktree && cloud && (
        <TitleTooltip title={cloudTitle ?? cloudLabel}>
          <span
            data-testid="task-cloud-badge"
            className="task-cloud-badge shrink-0 text-foreground-subtle"
            aria-label={cloudLabel}
          >
            <Cloud className="size-3.5" aria-hidden="true" />
          </span>
        </TitleTooltip>
      )}
      {!readOnly && (
        <HoverActions
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="task-row-actions"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={
              labels?.pinAction
                ? labels.pinAction(title, pinned)
                : `${pinned ? unpinLabel : pinLabel} ${title}`
            }
            disabled={disabled}
            onClick={onPin}
          >
            <Pin className="size-4" />
          </Button>
          {/* 运行中仍交给 Core 拒绝并显示原因，不在本地提前禁用或移走。 */}
          {onArchive && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={
                labels?.archiveAction ? labels.archiveAction(title) : `${archiveLabel} ${title}`
              }
              disabled={disabled || archived}
              onClick={onArchive}
            >
              <Archive className="size-4" />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={labels?.moreActions ? labels.moreActions(title) : `任务操作 ${title}`}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={onRename} disabled={disabled}>
                {renameLabel}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onPin} disabled={disabled}>
                {pinned ? unpinLabel : pinLabel}
              </DropdownMenuItem>
              {organizationActions}
              {onArchive && (
                <DropdownMenuItem onClick={onArchive} disabled={disabled || archived}>
                  {archiveLabel}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </HoverActions>
      )}
    </li>
  );
  return renderSurface ? renderSurface(surface.props) : surface;
});
