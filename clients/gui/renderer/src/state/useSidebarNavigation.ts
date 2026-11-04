import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
import type { Action, CommandParams, Data, PlatformServices, Snapshot } from "../services.js";
import type { useGuardedNavigation } from "../settings/UnsavedChanges.js";
import { useSidebarDrag, type SidebarDragSource } from "../sidebarDrag.js";
import type { conversationCatalog } from "./conversationCatalog.js";
import type { createNavigationWorkspace } from "./navigationWorkspace.js";
import type { useWorkbenchAppearance } from "./useWorkbenchAppearance.js";
export type SidebarNavigationProps = {
  snapshot: Snapshot;
  services: Pick<PlatformServices, "fileOpen">;
  setError: (message: string) => void;
  projects: Data[];
  summaries: ReturnType<typeof conversationCatalog>;
  projectId: string | undefined;
  threadId: string;
  taskCenterOpen: boolean;
  pluginsOpen: boolean;
  sidebar: boolean;
  visible: boolean;
  appearance: Pick<
    ReturnType<typeof useWorkbenchAppearance>,
    | "sidebarWidth"
    | "setSidebarWidth"
    | "collapsedProjects"
    | "setCollapsedProjects"
    | "toggleSidebarGroup"
  >;
  workspaceNavigation: ReactNode;
  applicationRail: ReactNode;
  navigation: ReturnType<typeof createNavigationWorkspace>;
  action: Action;
  requestNavigation: ReturnType<typeof useGuardedNavigation>;
  choose: () => Promise<void>;
  newTask: (projectId?: string) => void;
  open: (projectId: string, threadId: string) => Promise<void>;
  onOpenProjectTasks: (projectId: string) => void;
  closePanels: () => void;
};
const compareActivity = (a: Data, b: Data) =>
  b.updatedAt - a.updatedAt ||
  a.activityRank - b.activityRank ||
  (b.summary.createdAt ?? 0) - (a.summary.createdAt ?? 0) ||
  a.summary.id.localeCompare(b.summary.id);
export function useSidebarNavigation(props: SidebarNavigationProps) {
  const { snapshot, projects, summaries, action } = props;

  const { t } = useI18n();
  const view = useSyncExternalStore(props.navigation.subscribe, props.navigation.getSnapshot);
  const search = view.query;
  const archived = view.archived;
  const searchOpen = view.searchOpen;
  const setSearch = props.navigation.search;
  const setSearchOpen = (open: boolean) =>
    open ? props.navigation.openSearch() : props.navigation.hideSearch();
  const library = snapshot.library ?? {};
  const [projectVisibleCounts, setProjectVisibleCounts] = useState<Record<string, number>>({});
  type Rename = {
    [O in "renameProject" | "renameThread" | "renameSection"]: Omit<
      Extract<CommandParams<"library">, { operation: O }>,
      "title"
    >;
  }["renameProject" | "renameThread" | "renameSection"];
  const [rename, setRename] = useState<Rename | null>(null);
  const [renameText, setRenameText] = useState("");
  const startRename = (values: Rename, current: string) => {
    props.closePanels();
    setRename(values);
    setRenameText(current);
  };
  const sidebarKey = (row: Data) => `${row.owner.id}:${row.summary.id}`;
  const sidebarGroup = (row: Data) =>
    row.pinned ? "pinned" : row.owner.projectless ? "chats" : row.owner.id;
  const sortMode = (area: "Chats" | "Projects" | "Pinned") =>
    library.settings?.[`sidebarSort${area}`] ?? library.settings?.sidebarSort ?? "updated_at";
  const rowSortMode = (row: Data) =>
    sortMode(row.pinned ? "Pinned" : row.owner.projectless ? "Chats" : "Projects");
  const sortRows = (rows: Data[], mode: string) =>
    [...rows].sort((a, b) => {
      if (mode === "manual") {
        const order: string[] = library.sidebarThreadOrder ?? [];
        const rank = (row: Data) => {
          const index = order.indexOf(sidebarKey(row));
          return index < 0 ? order.length : index;
        };
        const difference = rank(a) - rank(b);
        if (difference) return difference;
      }
      if (mode === "priority") {
        const priority = (row: Data) => (row.attention ? 3 : row.unread ? 2 : row.running ? 1 : 0);
        const difference = priority(b) - priority(a);
        if (difference) return difference;
      }
      return compareActivity(a, b);
    });
  const organize = (request: CommandParams<"library">) =>
    void action("library", request).catch(() => {});
  const sidebarDrag = useSidebarDrag(
    (request) => action("library", request),
    library.sidebarRevision ?? 0,
  );
  const taskPlacement = (row: Data) =>
    row.pinned
      ? { type: "pinned" }
      : row.owner.projectless
        ? { type: "chats" }
        : { type: "project", id: row.owner.id };
  const projectPlacement = (id: string) =>
    library.projects?.[id]?.pinned ? { type: "pinned" } : { type: "projects" };
  const placementKey = (target: Data) => (target.id ? `${target.type}:${target.id}` : target.type);
  const dropRequest = (
    source: SidebarDragSource,
    target: import("../services.js").SidebarItem,
    edge: "before" | "after",
    anchor: string | null = null,
  ): Omit<
    Extract<CommandParams<"library">, { operation: "dropSidebar" }>,
    "expectedSidebarRevision"
  > | null => {
    if (source.type === "section") return null;
    if (source.type === "thread" && target.type === "projects")
      target = snapshot.projects.find((p) => p.id === source.projectId)?.projectless
        ? { type: "chats" }
        : { type: "project", id: source.projectId };
    if (source.type === "thread" && target.type === "project" && target.id !== source.projectId)
      return null;
    if (source.type === "project" && target.type === "project") return null;
    const key = source.type === "thread" ? `${source.projectId}:${source.id}` : source.id;
    if (anchor === key) return null;
    const order =
      source.type === "thread"
        ? sortRows(
            visibleRows.filter((row) => placementKey(taskPlacement(row)) === placementKey(target)),
            sortMode(
              target.type === "pinned" ? "Pinned" : target.type === "chats" ? "Chats" : "Projects",
            ),
          ).map(sidebarKey)
        : (target.type === "pinned" ? pinnedProjects : projects)
            .filter((owner) => placementKey(projectPlacement(owner.id)) === placementKey(target))
            .map((owner) => owner.id);
    return { operation: "dropSidebar", source, target, anchor, edge, order };
  };
  const visibleRows = useMemo(
    () =>
      [...summaries]
        .sort(compareActivity)
        .filter(
          (r) =>
            !!r.archived === archived &&
            `${r.title} ${r.owner.root}`.toLowerCase().includes(search.toLowerCase()),
        ),
    [summaries, archived, search],
  );
  const pinnedProjects = useMemo(() => {
    const mode =
      library.settings?.sidebarSortPinned ?? library.settings?.sidebarSort ?? "updated_at";
    return projects
      .filter((owner) => !owner.projectless && library.projects?.[owner.id]?.pinned)
      .sort((a, b) => {
        if (mode === "manual") return 0;
        const rows = (owner: Data) => visibleRows.filter((row) => row.owner.id === owner.id);
        if (mode === "priority") {
          const priority = (owner: Data) =>
            Math.max(
              0,
              ...rows(owner).map((row) =>
                row.attention ? 3 : row.unread ? 2 : row.running ? 1 : 0,
              ),
            );
          const difference = priority(b) - priority(a);
          if (difference) return difference;
        }
        return (
          Math.max(0, ...rows(b).map((row) => row.updatedAt)) -
          Math.max(0, ...rows(a).map((row) => row.updatedAt))
        );
      });
  }, [projects, library, visibleRows]);
  const dragSource = sidebarDrag.active;
  const dragTitle = !dragSource
    ? ""
    : dragSource.type === "thread"
      ? summaries.find(
          (row) => row.summary.id === dragSource.id && row.owner.id === dragSource.projectId,
        )?.title
      : dragSource.type === "section"
        ? ""
        : library.projects?.[dragSource.id]?.title ||
          projects
            .find((owner) => owner.id === dragSource.id)
            ?.root.split("/")
            .pop();
  return {
    services: props.services,
    setError: props.setError,
    library,
    projects,
    projectId: props.projectId,
    threadId: props.threadId,
    taskCenterOpen: props.taskCenterOpen,
    pluginsOpen: props.pluginsOpen,
    sidebar: props.sidebar,
    sidebarWidth: props.appearance.sidebarWidth,
    setSidebarWidth: props.appearance.setSidebarWidth,
    collapsedProjects: props.appearance.collapsedProjects,
    setCollapsedProjects: props.appearance.setCollapsedProjects,
    toggleSidebarGroup: props.appearance.toggleSidebarGroup,
    workspaceNavigation: props.workspaceNavigation,
    applicationRail: props.applicationRail,
    search,
    archived,
    searchOpen,
    setSearch,
    setSearchOpen,
    t,
    requestNavigation: props.requestNavigation,
    choose: props.choose,
    newTask: props.newTask,
    open: props.open,
    action,
    sidebarKey,
    sidebarGroup,
    sortMode,
    rowSortMode,
    sortRows,
    organize,
    sidebarDrag,
    taskPlacement,
    projectPlacement,
    placementKey,
    dropRequest,
    visibleRows,
    pinnedProjects,
    dragSource,
    dragTitle,
    startRename,
    projectVisibleCounts,
    setProjectVisibleCounts,
    rename,
    setRename,
    renameText,
    setRenameText,
    onOpenProjectTasks: props.onOpenProjectTasks,
  };
}
