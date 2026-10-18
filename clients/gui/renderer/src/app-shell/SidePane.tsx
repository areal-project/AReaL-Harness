import { useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { SideChatIcon as MessageCircle, SearchIcon as Search } from "../interfaceIcons.js";
import { SidePanelIcon } from "../homeChromeIcons.js";
import { BrowserPanelIcon, FilesPanelIcon, ReviewPanelIcon, TerminalPanelIcon, FullViewPanelIcon, AddPanelIcon } from "./panelIcons.js";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu.js";
import { Button } from "../components/ui/button.js";
import { SidePaneTabOverview } from "./SidePaneTabOverview.js";
import { SortableSidePaneTabTrigger } from "./SidePaneTabTrigger.js";
import { SidePaneLauncher } from "./SidePaneLauncher.js";
import type { WorkspaceSidePaneTab, RecentClosedSidePaneTab } from "./sidePaneModel.js";

export function SidePane({
  workspaceKey,
  ownerTaskId,
  active,
  names,
  onSelect,
  onChange,
  onHide,
  render,
  dirtyFiles,
  canClose,
  auxiliary,
  titleFor,
  workspaceView,
  previewTabId,
  onKeepTab,
}: {
  workspaceView?: {
    mode: "split" | "panel" | "conversation";
    title: string;
    onChange: (mode: "split" | "panel" | "conversation") => void;
    navigation?: ReactNode;
    actions?: ReactNode;
  };
  workspaceKey: string;
  ownerTaskId: string | null;
  active: string;
  names: string[];
  previewTabId?: string;
  onKeepTab?: (id: string) => void;
  onSelect: (name: string) => void;
  onChange: (names: string[]) => void;
  onHide: () => void;
  render: (name: string) => ReactNode;
  dirtyFiles: Record<string, boolean>;
  canClose: (names: string[]) => boolean | Promise<boolean>;
  auxiliary?: ReactNode;
  titleFor?: (name: string) => string | undefined;
}) {
  const fullView = !!workspaceView && workspaceView.mode !== "split";
  const conversationActive = workspaceView?.mode === "conversation";
  const panel = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const closingFocusedTab = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (closingFocusedTab.current === null || names.includes(closingFocusedTab.current)) return;
    closingFocusedTab.current = null;
    // Restore keyboard navigation only after a focused tab was actually removed.
    const target = panel.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"], [data-side-pane-open-tab-item]',
    );
    target?.focus();
  }, [names]);
  const initialWidth = Number(localStorage.getItem("areal-gui:side-width"));
  const [width, setWidth] = useState(initialWidth >= 25 && initialWidth <= 65 ? initialWidth : 45);
  const [closed, setClosed] = useState<RecentClosedSidePaneTab[]>([]);
  const [tabOverviewOpen, setTabOverviewOpen] = useState(false);
  const newTabButton = useRef<HTMLButtonElement>(null);
  const known = useRef(new Map<string, WorkspaceSidePaneTab>());
  const tabs = names.map((name) => {
    if (!known.current.has(name))
      known.current.set(name, {
        id: name,
        title: name.startsWith("file:")
          ? name.slice(5).split("/").pop()!
          : (({ 改动: "审查", 预览: "浏览器", 旁路讨论: "侧边聊天" } as Record<string, string>)[name] ?? name),
        openedAt: Date.now(),
        ownerTaskId,
        workspaceKey,
      });
    const tab = known.current.get(name)!;
    return {
      ...tab,
      title: (titleFor?.(name) ?? tab.title) + (name.startsWith("file:") && dirtyFiles[name.slice(5)] ? " •" : ""),
    };
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const current = useRef({ names, active }); current.current = { names, active };
  const closing = useRef(new Set<string>());
  const allowClose = async (ids: string[]) => {
    if (ids.some(id => closing.current.has(id))) return false;
    ids.forEach(id => closing.current.add(id));
    try { return await canClose(ids); }
    finally { ids.forEach(id => closing.current.delete(id)); }
  };
  const close = async (id: string) => {
    if (!await allowClose([id]) || !mounted.current) return;
    if (document.activeElement?.closest("[data-side-pane-tab-id]")?.getAttribute("data-side-pane-tab-id") === id) {
      closingFocusedTab.current = id;
    }
    const tab = known.current.get(id)!;
    if (!id.startsWith("terminal:")) setClosed((previous) =>
      [{ tab, closedAt: Date.now() }, ...previous.filter((p) => p.tab.id !== id)].slice(0, 20),
    );
    const remaining = current.current.names.filter((name) => name !== id);
    if (!remaining.length) setTabOverviewOpen(false);
    onChange(remaining);
    if (current.current.active === id) onSelect(remaining.at(-1) ?? "功能");
  };
  const closeGroup = async (keep?: string) => {
    const targets = names.filter((name) => name !== keep);
    if (!await allowClose(targets) || !mounted.current) return;
    setClosed((previous) =>
      [
        ...tabs.filter((t) => t.id !== keep && !t.id.startsWith("terminal:")).map((tab) => ({ tab, closedAt: Date.now() })),
        ...previous.filter((p) => !names.includes(p.tab.id)),
      ].slice(0, 20),
    );
    const remaining = current.current.names.filter(name => !targets.includes(name));
    if (!remaining.length) setTabOverviewOpen(false);
    onChange(remaining);
    if (targets.includes(current.current.active)) onSelect(keep ?? remaining.at(-1) ?? "功能");
  };
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const items = [
    { id: "review", panel: "改动", label: "审查", shortcut: mac ? "⌃⇧G" : "Ctrl+Shift+G", icon: ReviewPanelIcon, onOpen: () => onSelect("改动") },
    ...(ownerTaskId
      ? [{ id: "terminal", panel: "终端", label: "终端", shortcut: mac ? "⌃`" : "Ctrl+`", icon: TerminalPanelIcon, onOpen: () => onSelect("终端") }]
      : []),
    { id: "browser", panel: "预览", label: "浏览器", shortcut: mac ? "⌘T" : "Ctrl+T", icon: BrowserPanelIcon, onOpen: () => onSelect("预览") },
    { id: "files", panel: "文件", label: "文件", shortcut: mac ? "⌘P" : "Ctrl+P", icon: FilesPanelIcon, onOpen: () => onSelect("文件") },
  ].filter((item) => item.id === "terminal" || !names.includes(item.panel));
  return (
    <section
      ref={panel}
      className="side-panel workspace-side-panel"
      data-open={Boolean(active)}
      style={{ flexBasis: `${width}%`, display: active ? undefined : "none" }}
    >
      <div
        className="side-pane-resize"
        hidden={fullView}
        role="separator"
        aria-label="调整侧边面板宽度"
        aria-orientation="vertical"
        aria-valuemin={25}
        aria-valuemax={65}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={resize}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const rect = panel.current!.parentElement!.getBoundingClientRect();
          const next = Math.min(
            65,
            Math.max((240 / rect.width) * 100, ((rect.right - event.clientX) / rect.width) * 100),
          );
          setWidth(next);
          localStorage.setItem("areal-gui:side-width", String(next));
        }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const next = Math.min(65, Math.max(25, width + (event.key === "ArrowLeft" ? 2 : -2)));
          setWidth(next);
          localStorage.setItem("areal-gui:side-width", String(next));
        }}
      />
      <div className="side-pane-tabbar">
        {fullView && workspaceView.navigation}
        <Tabs value={conversationActive ? "__conversation" : active} onValueChange={id => id === "__conversation" ? workspaceView?.onChange("conversation") : onSelect(id)} className="side-pane-tabs-root" style={{ width: Math.max(0, tabs.length * 240 - 2 + (fullView ? 220 : 0)) }}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active, over }) => {
              if (over && active.id !== over.id)
                onChange(
                  arrayMove(
                    names,
                    names.indexOf(String(active.id)),
                    names.indexOf(String(over.id)),
                  ),
                );
            }}
          >
            <SortableContext items={names} strategy={horizontalListSortingStrategy}>
              <TabsList variant="line" className="side-pane-tabs-scroll" aria-label="侧边面板标签">
                {fullView && <TabsTrigger value="__conversation" className="side-pane-conversation-tab" aria-label={workspaceView.title}>
                  <MessageCircle className="size-4 shrink-0" />
                  <span className="truncate">{workspaceView.title}</span>
                </TabsTrigger>}
                {fullView && workspaceView.actions}
                {tabs.map((tab) => (
                  <SortableSidePaneTabTrigger
                    key={tab.id}
                    tab={tab}
                    title={tab.title}
                    closeTabLabel={`关闭 ${tab.title} 标签`}
                    closeTabMenuLabel="关闭标签页"
                    closeOtherTabsLabel="关闭其他标签页"
                    closeAllTabsLabel="关闭所有标签页"
                    diffBadgeLabel="改动"
                    isActive={!conversationActive && active === tab.id}
                    isPreview={tab.id === previewTabId}
                    onDoubleClick={() => {
                      onKeepTab?.(tab.id);
                      workspaceView?.onChange(fullView ? "split" : "panel");
                    }}
                    onKeepTab={onKeepTab}
                    onCloseTab={close}
                    onCloseOtherTabs={closeGroup}
                    onCloseAllTabs={() => closeGroup()}
                    canCloseOtherTabs={tabs.length > 1}
                  />
                ))}
              </TabsList>
            </SortableContext>
          </DndContext>
        </Tabs>
        {tabs.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button ref={newTabButton} size="icon" variant="ghost" aria-label="打开侧边面板标签页">
                  <AddPanelIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end" finalFocus={tabOverviewOpen ? false : undefined}>
              {items.map((item) => (
                <DropdownMenuItem key={item.id} onClick={item.onOpen}>
                  <item.icon />
                  {item.label}
                  <kbd className="side-pane-launcher-shortcut">{item.shortcut}</kbd>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setTabOverviewOpen(true)}>
                <Search />搜索标签页
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {tabs.length > 0 && (
          <SidePaneTabOverview
            tabs={tabs}
            activeTabId={active}
            recentClosedTabs={closed.filter((c) => !names.includes(c.tab.id))}
            menuEntry={{ open: tabOverviewOpen, onOpenChange: setTabOverviewOpen, anchor: newTabButton }}
            labels={{
              title: "搜索标签页",
              searchPlaceholder: "搜索标签页…",
              openTabs: "打开的标签页",
              recentlyClosedTabs: "最近关闭",
              noResults: "没有匹配的标签页",
              closeTab: (title) => `关闭 ${title} 标签`,
              relativeTime: (timestamp) =>
                Date.now() - timestamp < 60000
                  ? "刚刚"
                  : `${Math.floor((Date.now() - timestamp) / 60000)} 分钟前`,
            }}
            onActivateTab={onSelect}
            onCloseTab={close}
            onReopenClosedTab={(id) => {
              onSelect(id);
              setClosed((previous) => previous.filter((p) => p.tab.id !== id));
            }}
          />
        )}
        {workspaceView && <Button size="icon" variant="ghost" className="ml-auto"
          aria-label={fullView ? "退出完整视图" : "进入完整视图"} aria-pressed={fullView}
          onClick={() => workspaceView.onChange(fullView ? "split" : "panel")}>
          <FullViewPanelIcon expanded={fullView} />
        </Button>}
        <Button
          className={workspaceView ? undefined : "ml-auto"}
          size="icon"
          variant="ghost"
          aria-label={fullView ? "进入分屏视图" : "关闭面板"}
          onClick={() => fullView ? workspaceView.onChange("split") : onHide()}
        >
          <SidePanelIcon />
        </Button>
      </div>
      <div className="panel-resource-layout" data-file-preview={active.startsWith("file:") || undefined}>
        <div className={`panel-content ${active === "功能" || ["预览", "终端", "改动", "文件", "旁路讨论"].includes(active) || active.startsWith("file:") || active.startsWith("terminal:") ? "full-height" : ""}`}>
          {active === "功能" ? <SidePaneLauncher items={items} /> : render(active)}
        </div>
        {auxiliary && <aside className="panel-resource-tree" aria-label="文件列表">{auxiliary}</aside>}
      </div>
    </section>
  );
}
