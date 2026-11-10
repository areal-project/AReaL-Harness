import {
  useReadOnly,
  useLibraryReadOnly,
  useConversationCreateReadOnly,
} from "../PlatformReadContext.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { Input } from "../components/ui/input.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { createContext, useContext } from "react";
import {
  SidebarSectionToggle,
  SidebarWorkspaceHeader,
} from "../app-shell/ApplicationNavigation.js";
import { NavigationSidebar } from "../app-shell/WorkbenchShell.js";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { HoverActions } from "../components/ui/hover-actions.js";
import {
  ComposerPlusIcon,
  ProjectFolderIcon,
  ProjectNewChatIcon,
  ProjectOpenFolderIcon,
} from "../homeChromeIcons.js";
import { DismissIcon, MoreOptionsIcon, SearchIcon } from "../interfaceIcons.js";
import { NewTaskButtonGroup } from "../NewTaskButtonGroup.js";
import type { Data } from "../services.js";
import { SidebarDragSurface } from "../sidebarDrag.js";
import {
  useSidebarNavigation,
  type SidebarNavigationProps,
} from "../state/useSidebarNavigation.js";
import { MemoTaskItem } from "../TaskListItem.js";
import { ProjectMigrationNotice } from "./ProjectMigrationNotice.js";

const SidebarContext = createContext<ReturnType<typeof useSidebarNavigation> | null>(null);
function useSidebarContext() {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("Sidebar context is missing");
  return context;
}

export function ConversationNavigation(props: SidebarNavigationProps) {
  const model = useSidebarNavigation(props);
  return (
    <SidebarContext.Provider value={model}>
      {props.visible && <SidebarContent onUpgradeHistory={props.onUpgradeHistory} />}
      <SidebarSearch />
      <SidebarRename />
    </SidebarContext.Provider>
  );
}
function SidebarTaskRow({ row }: { row: Data }) {
  const { t } = useI18n();
  const {
    projectId,
    threadId,
    search,
    open,
    action,
    sidebarKey,
    sidebarGroup,
    rowSortMode,
    sortRows,
    organize,
    sidebarDrag,
    taskPlacement,
    placementKey,
    dropRequest,
    visibleRows,
    startRename,
  } = useSidebarContext();
  return (
    <MemoTaskItem
      key={`${row.owner.id}:${row.summary.id}`}
      id={row.summary.id}
      nested={!row.pinned}
      title={row.title}
      worktree={row.summary.worktree}
      active={projectId === row.owner.id && threadId === row.summary.id}
      pinned={row.pinned}
      running={row.running}
      attention={row.attention}
      unread={row.unread}
      statePending={row.statePending}
      dragProps={{
        ...sidebarDrag.source(
          {
            type: "thread",
            id: row.summary.id,
            projectId: row.owner.id,
            group: placementKey(taskPlacement(row)),
          },
          row.owner.pending.some((entry: Data) => entry.params?.threadId === row.summary.id) ||
            !!search,
        ),
        ...sidebarDrag.target(`thread:${sidebarKey(row)}`, (source, edge) =>
          source.type === "thread"
            ? dropRequest(source, taskPlacement(row), edge, sidebarKey(row))
            : null,
        ),
      }}
      organizationActions={
        <>
          <DropdownMenuItem
            onClick={() =>
              organize({
                operation: "readThread",
                projectId: row.owner.id,
                threadId: row.summary.id,
                read: row.unread,
              })
            }
          >
            {row.unread ? t("common.navigation.markRead") : t("common.navigation.markUnread")}
          </DropdownMenuItem>
          {(
            [
              [-1, "common.navigation.moveUp"],
              [1, "common.navigation.moveDown"],
            ] as const
          ).map(([direction, label]) => {
            const siblings = sortRows(
              visibleRows.filter((candidate) => sidebarGroup(candidate) === sidebarGroup(row)),
              rowSortMode(row),
            );
            const index = siblings.findIndex(
              (candidate) => sidebarKey(candidate) === sidebarKey(row),
            );
            return (
              <DropdownMenuItem
                key={label}
                disabled={
                  rowSortMode(row) !== "manual" ||
                  index + direction < 0 ||
                  index + direction >= siblings.length
                }
                onClick={() =>
                  organize({
                    operation: "orderSidebarThread",
                    projectId: row.owner.id,
                    threadId: row.summary.id,
                    before:
                      direction < 0
                        ? sidebarKey(siblings[index - 1])
                        : siblings[index + 2]
                          ? sidebarKey(siblings[index + 2])
                          : null,
                  })
                }
              >
                {t(label)}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
        </>
      }
      archived={row.archived}
      disabled={row.owner.pending.some((entry: Data) => entry.params?.threadId === row.summary.id)}
      onSelect={() => void open(row.owner.id, row.summary.id)}
      onRename={() =>
        startRename(
          {
            operation: "renameThread",
            projectId: row.owner.id,
            threadId: row.summary.id,
          },
          row.title,
        )
      }
      onPin={() =>
        void action("library", {
          operation: "pinThread",
          projectId: row.owner.id,
          threadId: row.summary.id,
          pinned: !row.pinned,
        }).catch(() => {})
      }
      onArchive={() =>
        void action("manage", {
          projectId: row.owner.id,
          threadId: row.summary.id,
          operation: "archive",
        }).catch(() => {})
      }
    />
  );
}
function SidebarProjectGroup({ owner }: { owner: Data }) {
  const conversationCreateReadOnly = useConversationCreateReadOnly();
  const libraryReadOnly = useLibraryReadOnly();
  const { t } = useI18n();
  const {
    services,
    setError,
    library,
    projects,
    projectId,
    threadId,
    taskCenterOpen,
    collapsedProjects,
    setCollapsedProjects,
    search,
    newTask,
    sortMode,
    sortRows,
    organize,
    sidebarDrag,
    projectPlacement,
    placementKey,
    dropRequest,
    visibleRows,
    startRename,
    projectVisibleCounts,
    setProjectVisibleCounts,
  } = useSidebarContext();
  const rows = sortRows(
    visibleRows.filter((r) => r.owner.id === owner.id && !r.pinned),
    sortMode("Projects"),
  );
  const collapsed = collapsedProjects[owner.id] ?? false;
  const visibleCount = projectVisibleCounts[owner.id] ?? 5;
  return (
    <section className="project-group" key={owner.id} data-sidebar-project={owner.id}>
      <SidebarDragSurface
        className="project-row group/project"
        {...sidebarDrag.source(
          {
            type: "project",
            id: owner.id,
            group: placementKey(projectPlacement(owner.id)),
          },
          !!search,
        )}
        {...sidebarDrag.target(`project:${owner.id}`, (source, edge) =>
          source.type === "thread"
            ? dropRequest(source, { type: "project", id: owner.id }, edge)
            : source.type === "project"
              ? dropRequest(source, projectPlacement(owner.id), edge, owner.id)
              : null,
        )}
      >
        <Button
          unstyled
          className="project-label"
          aria-current={!taskCenterOpen && projectId === owner.id && !threadId ? "page" : undefined}
          aria-expanded={!collapsed}
          aria-controls={`project-threads-${owner.id}`}
          onClick={() => {
            setCollapsedProjects((current) => ({
              ...current,
              [owner.id]: !current[owner.id],
            }));
            setProjectVisibleCounts((current) => ({ ...current, [owner.id]: 5 }));
          }}
        >
          {collapsed ? <ProjectFolderIcon /> : <ProjectOpenFolderIcon />}
          <span>{library.projects?.[owner.id]?.title || owner.root.split("/").pop()}</span>
        </Button>
        {!libraryReadOnly && (
          <HoverActions className="project-actions">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    unstyled
                    className="icon-button"
                    aria-label={t("common.navigation.projectActions", {
                      project: library.projects?.[owner.id]?.title || owner.root.split("/").pop(),
                    })}
                  >
                    <MoreOptionsIcon size={16} />
                  </Button>
                }
              />
              <DropdownMenuContent>
                <DropdownMenuItem
                  onClick={() =>
                    startRename(
                      { operation: "renameProject", projectId: owner.id },
                      library.projects?.[owner.id]?.title || owner.root.split("/").pop(),
                    )
                  }
                >
                  {t("common.navigation.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!services.fileOpen}
                  onClick={() =>
                    void services
                      .fileOpen?.({
                        operation: "open",
                        projectId: owner.id,
                        path: ".",
                      })
                      .catch((cause) => setError(cause.message))
                  }
                >
                  {t("common.navigation.openDefault")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!services.fileOpen}
                  onClick={() =>
                    void services
                      .fileOpen?.({
                        operation: "reveal",
                        projectId: owner.id,
                        path: ".",
                      })
                      .catch((cause) => setError(cause.message))
                  }
                >
                  {t("common.navigation.reveal")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    organize({
                      operation: "pinProject",
                      projectId: owner.id,
                      pinned: !library.projects?.[owner.id]?.pinned,
                    })
                  }
                >
                  {library.projects?.[owner.id]?.pinned
                    ? t("common.navigation.unpinProject")
                    : t("common.navigation.pinProject")}
                </DropdownMenuItem>
                {(
                  [
                    [-1, "common.navigation.moveUp"],
                    [1, "common.navigation.moveDown"],
                  ] as const
                ).map(([direction, label]) => {
                  const siblings = projects.filter(
                    (candidate) =>
                      !!library.projects?.[candidate.id]?.pinned ===
                      !!library.projects?.[owner.id]?.pinned,
                  );
                  const index = siblings.findIndex((candidate) => candidate.id === owner.id);
                  return (
                    <DropdownMenuItem
                      key={label}
                      disabled={
                        (library.projects?.[owner.id]?.pinned && sortMode("Pinned") !== "manual") ||
                        index + direction < 0 ||
                        index + direction >= siblings.length
                      }
                      onClick={() =>
                        organize({
                          operation: "orderProject",
                          projectId: owner.id,
                          before:
                            direction < 0
                              ? siblings[index - 1].id
                              : (siblings[index + 2]?.id ?? null),
                        })
                      }
                    >
                      {t(label)}
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuItem
                  onClick={() =>
                    organize({ operation: "hideProject", projectId: owner.id, hidden: true })
                  }
                >
                  {t("common.navigation.hideProject")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {!conversationCreateReadOnly && (
              <Button
                unstyled
                type="button"
                className="icon-button"
                aria-label={t("common.navigation.newProjectChat", {
                  project: library.projects?.[owner.id]?.title || owner.root.split("/").pop(),
                })}
                title={t("common.navigation.newProjectChat", {
                  project: library.projects?.[owner.id]?.title || owner.root.split("/").pop(),
                })}
                onClick={() => newTask(owner.id)}
              >
                <ProjectNewChatIcon />
              </Button>
            )}
          </HoverActions>
        )}
      </SidebarDragSurface>
      <ProjectMigrationNotice hostState={owner.state?.hostState} />
      <div id={`project-threads-${owner.id}`} hidden={collapsed}>
        <ul>
          {rows.slice(0, visibleCount).map((row) => (
            <SidebarTaskRow key={`${row.owner.id}:${row.summary.id}`} row={row} />
          ))}
        </ul>
        {rows.length > visibleCount && (
          <Button
            unstyled
            type="button"
            className="project-show-more"
            onClick={() =>
              setProjectVisibleCounts((current) => ({
                ...current,
                [owner.id]: (current[owner.id] ?? 5) + 5,
              }))
            }
          >
            {t("common.navigation.showMore")}
          </Button>
        )}
      </div>
    </section>
  );
}
function SidebarContent({ onUpgradeHistory }: { onUpgradeHistory?: () => void }) {
  const readOnly = useReadOnly();
  const conversationCreateReadOnly = useConversationCreateReadOnly();
  const libraryReadOnly = useLibraryReadOnly();
  const {
    library,
    projects,
    taskCenterOpen,
    pluginsOpen,
    sidebar,
    sidebarWidth,
    setSidebarWidth,
    collapsedProjects,
    toggleSidebarGroup,
    workspaceNavigation,
    applicationRail,
    archived,
    setSearchOpen,
    t,
    requestNavigation,
    choose,
    newTask,
    sidebarKey,
    sortMode,
    sortRows,
    organize,
    sidebarDrag,
    dropRequest,
    visibleRows,
    pinnedProjects,
    dragSource,
    dragTitle,
  } = useSidebarContext();
  return (
    <NavigationSidebar
      id="areal-sidebar"
      data-testid="areal-sidebar"
      data-collapsed={pluginsOpen || !sidebar}
      railOnly={taskCenterOpen || pluginsOpen || !sidebar}
      width={sidebarWidth}
      onWidthChange={setSidebarWidth}
      chrome={workspaceNavigation}
      rail={applicationRail}
      footer={null}
    >
      <>
        <SidebarWorkspaceHeader title="AReaL Harness" onSearch={() => setSearchOpen(true)} />
        {!conversationCreateReadOnly && (
          <div className="sidebar-tools">
            <NewTaskButtonGroup onCreateTask={() => void newTask()} />
          </div>
        )}
        {onUpgradeHistory && (
          <div className="sidebar-tools">
            <Button variant="ghost" onClick={onUpgradeHistory}>
              {t("upgrade.history")}
            </Button>
          </div>
        )}
        {
          <DndContext {...sidebarDrag.context}>
            <div className="sidebar-scroll">
              {(visibleRows.some((r) => r.pinned) ||
                projects.some((owner) => library.projects?.[owner.id]?.pinned) ||
                (sidebarDrag.active && sidebarDrag.active.type !== "section")) && (
                <section className="project-group" data-sidebar-pinned>
                  <SidebarDragSurface
                    className="section-heading"
                    data-sidebar-drop-zone="pinned"
                    {...sidebarDrag.target("pinned", (source, edge) =>
                      dropRequest(source, { type: "pinned" }, edge),
                    )}
                  >
                    <SidebarSectionToggle
                      label={t("common.navigation.pinned")}
                      ariaLabel={t("common.navigation.pinnedSection")}
                      controls="sidebar-pinned"
                      expanded={!collapsedProjects["sidebar:pinned"]}
                      onToggle={() => toggleSidebarGroup("sidebar:pinned")}
                    />
                  </SidebarDragSurface>
                  <div id="sidebar-pinned" hidden={!!collapsedProjects["sidebar:pinned"]}>
                    {pinnedProjects.map((owner) => (
                      <SidebarProjectGroup key={owner.id} owner={owner} />
                    ))}
                    <ul>
                      {sortRows(
                        visibleRows.filter((r) => r.pinned),
                        sortMode("Pinned"),
                      ).map((row) => (
                        <SidebarTaskRow key={`${row.owner.id}:${row.summary.id}`} row={row} />
                      ))}
                    </ul>
                  </div>
                </section>
              )}
              <section className="project-group" data-sidebar-projects>
                <SidebarDragSurface
                  className="section-heading"
                  data-sidebar-drop-zone="projects"
                  {...sidebarDrag.target("projects", (source, edge) =>
                    dropRequest(source, { type: "projects" }, edge),
                  )}
                >
                  <SidebarSectionToggle
                    label={archived ? t("common.navigation.archived") : t("worktree.project")}
                    ariaLabel={t("common.navigation.projectSection")}
                    controls="sidebar-projects"
                    expanded={!collapsedProjects["sidebar:projects"]}
                    onToggle={() => toggleSidebarGroup("sidebar:projects")}
                  />
                  {!libraryReadOnly && (
                    <>
                      {!readOnly && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="section-action-btn"
                          aria-label={t("settings.openProject")}
                          title={t("settings.openProject")}
                          onClick={() => void requestNavigation(() => void choose())}
                        >
                          <ComposerPlusIcon width={16} height={16} />
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              unstyled
                              className="section-action-btn"
                              aria-label={t("common.navigation.organize")}
                            >
                              <MoreOptionsIcon size={16} />
                            </Button>
                          }
                        />
                        <DropdownMenuContent>
                          {!readOnly && (
                            <>
                              <DropdownMenuItem
                                onClick={() => void requestNavigation(() => void choose())}
                              >
                                {t("chat.newProject")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          {(
                            [
                              ["Chats", "独立任务排序"],
                              ["Projects", "项目内任务排序"],
                              ["Pinned", "置顶项排序"],
                            ] as const
                          ).map(([area, label]) => (
                            <DropdownMenuSub key={area}>
                              <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                <DropdownMenuRadioGroup
                                  value={sortMode(area)}
                                  onValueChange={(value) =>
                                    organize({
                                      operation: "settings",
                                      key: `sidebarSort${area}`,
                                      value,
                                      order: visibleRows.map(sidebarKey),
                                    })
                                  }
                                >
                                  {(
                                    [
                                      ["updated_at", "最近更新"],
                                      ["priority", "优先处理"],
                                      ["manual", "手动排序"],
                                    ] as const
                                  ).map(([value, title]) => (
                                    <DropdownMenuRadioItem key={value} value={value}>
                                      {title}
                                    </DropdownMenuRadioItem>
                                  ))}
                                </DropdownMenuRadioGroup>
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => organize({ operation: "markAllRead" })}>
                            {t("common.navigation.markAllRead")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </SidebarDragSurface>
                <div id="sidebar-projects" hidden={!!collapsedProjects["sidebar:projects"]}>
                  {projects
                    .filter((owner) => !owner.projectless && !library.projects?.[owner.id]?.pinned)
                    .map((owner) => (
                      <SidebarProjectGroup key={owner.id} owner={owner} />
                    ))}
                  {!projects.length && (
                    <p className="empty-tasks">{t("common.navigation.openProject")}</p>
                  )}
                </div>
              </section>
              {visibleRows.some((row) => row.owner.projectless && !row.pinned) && (
                <section className="project-group" data-sidebar-chats>
                  <SidebarDragSurface
                    className="section-heading"
                    data-sidebar-drop-zone="chats"
                    {...sidebarDrag.target("chats", (source, edge) =>
                      source.type === "thread"
                        ? dropRequest(source, { type: "projects" }, edge)
                        : null,
                    )}
                  >
                    <SidebarSectionToggle
                      label={t("common.navigation.tasks")}
                      ariaLabel={t("common.navigation.taskSection")}
                      controls="sidebar-chats"
                      expanded={!collapsedProjects["sidebar:chats"]}
                      onToggle={() => toggleSidebarGroup("sidebar:chats")}
                    />
                  </SidebarDragSurface>
                  <div id="sidebar-chats" hidden={!!collapsedProjects["sidebar:chats"]}>
                    <ul>
                      {sortRows(
                        visibleRows.filter((row) => row.owner.projectless && !row.pinned),
                        sortMode("Chats"),
                      ).map((row) => (
                        <SidebarTaskRow key={`${row.owner.id}:${row.summary.id}`} row={row} />
                      ))}
                    </ul>
                  </div>
                </section>
              )}
            </div>
            <DragOverlay dropAnimation={null}>
              {dragSource && <div className="sidebar-drag-preview">{dragTitle}</div>}
            </DragOverlay>
          </DndContext>
        }
      </>
    </NavigationSidebar>
  );
}
function SidebarSearch() {
  const { t } = useI18n();
  const { search, searchOpen, setSearch, setSearchOpen, open, visibleRows } = useSidebarContext();
  return (
    <>
      {searchOpen && (
        <div
          className="dialog-backdrop search-backdrop"
          onClick={() => {
            setSearchOpen(false);
            setSearch("");
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t("common.navigation.searchTasks")}
            className="search-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="search">
              <SearchIcon size={18} />
              <Input
                unstyled
                autoFocus
                aria-label={t("common.navigation.searchTasks")}
                placeholder={t("common.navigation.searchTasks")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button
                unstyled
                className="icon-button"
                aria-label={t("common.navigation.closeSearch")}
                onClick={() => {
                  setSearchOpen(false);
                  setSearch("");
                }}
              >
                <DismissIcon size={14} />
              </Button>
            </div>
            <div className="search-results">
              {visibleRows.length ? (
                visibleRows.map((row) => (
                  <Button
                    unstyled
                    key={`${row.owner.id}:${row.summary.id}`}
                    onClick={() => {
                      setSearchOpen(false);
                      setSearch("");
                      void open(row.owner.id, row.summary.id);
                    }}
                  >
                    <i aria-hidden="true" className="size-4 shrink-0" />
                    <span>{row.title}</span>
                    <small>{row.owner.root.split("/").pop()}</small>
                  </Button>
                ))
              ) : (
                <p>{t("common.navigation.noMatches")}</p>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
function SidebarRename() {
  const { t } = useI18n();
  const { action, rename, setRename, renameText, setRenameText } = useSidebarContext();
  return (
    <Dialog open={!!rename} onOpenChange={(open) => !open && setRename(null)}>
      <DialogContent className="max-w-[min(calc(var(--reading-width)/2),calc(100%-var(--spacing-field)*2))]">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (!rename || !renameText.trim()) return;
            void action("library", { ...rename, title: renameText.trim() })
              .then(() => setRename(null))
              .catch(() => {});
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("common.navigation.rename")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t("common.navigation.name")}
            maxLength={200}
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
          />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("common.navigation.cancel")}
            </DialogClose>
            <Button type="submit" disabled={!renameText.trim()}>
              {t("common.navigation.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
