/* Adapted from ZCode 872ad960 TaskListItem.tsx: original default row markup,
 * title overflow and action geometry. Core supplies state and callbacks. */
import { memo, type ReactNode, type ComponentProps } from 'react';
import { LoaderIcon, CircleDashed, GitFork } from 'lucide-react';
import { ArchiveChatIcon as Archive, PinChatIcon as Pin, MoreOptionsIcon as MoreHorizontal, EditMessageIcon as PenLine } from '../../icons.js';
import { cn } from '../../lib/utils.js';
import { TaskTitleOverflowText } from '../task-title-overflow/task-title-overflow.js';
import { Button } from '../../components/button/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/dropdown-menu/dropdown-menu.js';
export const MemoTaskItem = memo(function TaskListItem({ id, title, worktree, active, pinned, running, attention, archived, disabled, unread = false, statePending = false, nested = true, instanceId, renderSurface, reducedMotion = false, worktreeLabel, worktreeTitle, organizationActions, onSelect, onRename, onPin, onArchive }: {
    id: string;
    title: string;
    worktree?: {branch: string; directory: string; state?: string};
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
    reducedMotion?: boolean; worktreeLabel?: string; worktreeTitle?: string;
    organizationActions?: ReactNode;
    onSelect: () => void;
    onRename: () => void;
    onPin: () => void;
    onArchive: () => void;
}) {
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
        {(nested || statePending || running || attention || unread || archived) && <div className="relative flex size-4 shrink-0 items-center justify-center">
          {statePending ? (
            <span role="img" aria-label="状态待更新" title="打开任务以更新状态"><CircleDashed className="size-3.5 text-foreground-subtle" /></span>
          ) : running ? (
            <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none text-foreground-subtle" />
          ) : attention ? (
            <span className="size-1.5 rounded-full bg-warning" />
          ) : unread ? (
            <span className="size-1.5 rounded-full bg-primary" aria-label="未读" />
          ) : pinned ? (
            <Pin className="size-3.5 text-foreground-subtle" />
          ) : archived ? (
            <Archive className="size-3.5 text-foreground-subtle" />
          ) : null}
        </div>}
        <div className="task-row-title flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex flex-1 items-center gap-1.5">
              <TaskTitleOverflowText reducedMotion={reducedMotion} className="navigation-task-title" title={title}>
                {title}
              </TaskTitleOverflowText>

            </div>
          </div>
        </div>
        {worktree && <span data-testid="task-worktree-badge" className="task-worktree-badge shrink-0 text-foreground-subtle"
          title={worktreeTitle}
          aria-label={worktreeLabel}>
          <GitFork className="size-3.5" aria-hidden="true" />
        </span>}
        <span
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="task-row-actions"
        >
          <Button variant="ghost" size="icon-xs" aria-label={`${pinned ? "取消置顶" : "置顶"} ${title}`} disabled={disabled} onClick={onPin}>
            <Pin className="size-4" />
          </Button>
          {/* 运行中仍交给 Core 拒绝并显示原因，不在本地提前禁用或移走。 */}
          <Button variant="ghost" size="icon-xs" aria-label={`归档 ${title}`} disabled={disabled || archived} onClick={onArchive}>
            <Archive className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" aria-label={`任务操作 ${title}`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={onRename} disabled={disabled}>
                <PenLine />
                重命名
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onPin} disabled={disabled}>
                <Pin />
                {pinned ? "取消置顶" : "置顶"}
              </DropdownMenuItem>
              {organizationActions}
              <DropdownMenuItem onClick={onArchive} disabled={disabled || archived}>
                <Archive />
                归档
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </li>
    );
    return renderSurface ? renderSurface(surface.props) : surface;
});
