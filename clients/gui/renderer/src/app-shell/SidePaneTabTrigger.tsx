import { TaskSummaryIcon } from "../homeChromeIcons.js";
import { AgentAvatar } from "../AgentIdentity.js";
import { CloseIcon as XIcon } from "../interfaceIcons.js";
import { useRef, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BoxesIcon, TargetIcon, ListChecksIcon, FileTextIcon, ShieldCheckIcon, CalendarClockIcon } from "lucide-react";
import { BrowserPanelIcon, DocumentPanelIcon, FilesPanelIcon, ReviewPanelIcon, TerminalPanelIcon } from "./panelIcons.js";
import { cn } from "../components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.js";
import { TabsTrigger } from "../components/ui/tabs.js";
import { Button } from "../components/ui/button.js";
import { SidePaneTabTitleTooltip } from "./SidePaneTabTitleTooltip.js";
import type { WorkspaceSidePaneTab } from "./sidePaneModel.js";
export function SidePaneTabIcon({ tab }: { tab: WorkspaceSidePaneTab }) {
  if (tab.id.startsWith("agent:")) return <AgentAvatar id={tab.id.slice(6)} size={14} />;
  if (tab.id.startsWith("terminal:")) return <TerminalPanelIcon className="size-4 shrink-0" />;
  if (tab.id.startsWith("file:")) return <DocumentPanelIcon className="size-4 shrink-0" />;
  const Icon =
    (
      { 任务资源: TaskSummaryIcon, 文件: FilesPanelIcon, 改动: ReviewPanelIcon, 预览: BrowserPanelIcon, 终端: TerminalPanelIcon, 进程: TerminalPanelIcon, 编辑目标: TargetIcon, 执行计划: ListChecksIcon, 上下文: FileTextIcon, 已保存授权: ShieldCheckIcon, 自动化: CalendarClockIcon, CalendarClockIcon } as Record<
        string,
        typeof FilesPanelIcon
      >
    )[tab.id] ?? BoxesIcon;
  return <Icon className="size-4 shrink-0" />;
}
export function SortableSidePaneTabTrigger({
  tab,
  title,
  closeTabLabel,
  closeTabMenuLabel,
  closeOtherTabsLabel,
  closeAllTabsLabel,
  diffBadgeLabel,
  isActive,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  canCloseOtherTabs,
  isPreview,
  onDoubleClick,
  onKeepTab,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  closeTabLabel: string;
  closeTabMenuLabel: string;
  closeOtherTabsLabel: string;
  closeAllTabsLabel: string;
  diffBadgeLabel: string;
  isActive: boolean;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  canCloseOtherTabs: boolean;
  isPreview?: boolean;
  onDoubleClick?: () => void;
  onKeepTab?: (id: string) => void;
}) {
  const wasDraggingRef = useRef(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const normalizedTransform = transform
    ? {
        ...transform,
        // 横向 tabs 是固定高度控件，拖拽时只允许水平位移。
        // dnd-kit 会携带 scale 信息；这里钳回 1，避免 tab 被临时压缩或拉伸。
        scaleX: 1,
        scaleY: 1,
      }
    : null;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(normalizedTransform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  if (isDragging) {
    wasDraggingRef.current = true;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={setNodeRef}
            data-side-pane-tab-id={tab.id}
            data-active={isActive ? "" : undefined}
            style={style}
            className={cn(
              "group relative inline-flex h-8 min-w-15 max-w-[238px] flex-[1_1_0] items-center rounded-navigation text-ui-caption",
              isActive
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-hover hover:text-foreground",
              isDragging && "cursor-grabbing shadow-overlay",
            )}
          >
            <SidePaneTabTitleTooltip isDragging={isDragging} title={title}>
              <TabsTrigger
                value={tab.id}
                {...attributes}
                {...listeners}
                role="tab"
                aria-label={title}
                aria-keyshortcuts="Delete"
                onKeyDown={(event) => {
                  if (event.key === "Delete") {
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  } else {
                    listeners?.onKeyDown?.(event);
                  }
                }}
                className="h-full min-w-0 flex-1 justify-start gap-1 border-0 bg-transparent pl-2.5 pr-[27px] py-1 text-ui-caption text-inherit data-active:bg-transparent after:hidden"
                onPointerDown={(event) => {
                  // A new gesture must not inherit the previous drag's click guard.
                  wasDraggingRef.current = false;
                  listeners?.onPointerDown?.(event);
                  // Dragging or a secondary press must not activate the tab through focus.
                  event.preventDefault();
                }}
                onClick={(event) => {
                  if (event.button === 1 || (wasDraggingRef.current && event.detail > 0)) {
                    wasDraggingRef.current = false;
                    event.preventDefault();
                    event.preventBaseUIHandler();
                  }
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
                onDoubleClick={() => {
                  if (!wasDraggingRef.current) onDoubleClick?.();
                }}
              >
                <SidePaneTabIcon tab={tab} />
                <span className={cn("min-w-0 flex-1 truncate text-start", isPreview && "italic")}>{title}</span>
              </TabsTrigger>
            </SidePaneTabTitleTooltip>
            {/* The pointer close affordance is outside the tab's accessible name.
              Keyboard users close the focused tab with Delete or its context menu. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={closeTabLabel}
              aria-hidden="true"
              tabIndex={-1}
              className={cn(
                "absolute right-[7px] top-1/2 -translate-y-1/2 rounded-control",
                !isActive &&
                  "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        }
      />
      <ContextMenuContent className="w-44">
        {isPreview && onKeepTab && <ContextMenuItem onClick={() => onKeepTab(tab.id)}>保留标签页</ContextMenuItem>}
        <ContextMenuItem onClick={() => onCloseTab(tab.id)}>{closeTabMenuLabel}</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOtherTabs} onClick={() => onCloseOtherTabs(tab.id)}>
          {closeOtherTabsLabel}
        </ContextMenuItem>
        <ContextMenuItem onClick={onCloseAllTabs}>{closeAllTabsLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
