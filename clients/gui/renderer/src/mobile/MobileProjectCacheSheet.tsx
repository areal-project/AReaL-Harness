import { useEffect, useState } from "react";
import { Folder, HardDrive, Trash2 } from "lucide-react";
import { Button, Switch } from "@areal/ui";
import { FeedbackNotice } from "../FeedbackNotice.js";
import { readObservationResult } from "../host-services.js";
import type { SessionRead, ShellProject } from "@areal/client";
import { useI18n } from "../i18n/IntlProvider.js";
import { Messages } from "../Messages.js";
import { projectedTurns } from "../remote/session-projection.js";
import { SettingsDialog } from "../settings/common.js";
import type { Action, Data } from "../services.js";
import type { MobileCacheStore, MobileHostCacheView } from "./mobile-cache.js";
import { SESSION_PAGE_SIZE } from "./mobile-workspace.mjs";

export function projectDisplayName(project: Pick<ShellProject, "projectId" | "workspace">) {
  const folder = project.workspace.split("/").filter(Boolean).at(-1);
  return folder || project.projectId;
}

export function formatCacheBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function visibleAuthorizedProjects(cacheView: MobileHostCacheView | null) {
  const projects = cacheView?.meta?.shell?.snapshot.projects ?? [];
  const regular = projects.filter((p) => !p.projectless);
  return regular.length ? regular : projects;
}

export function MobileProjectCacheSheet({
  open,
  onClose,
  cacheView,
  onSelectProject,
  onToggleProjectCache,
  onEnableAllCache,
  onClearProjectSessions,
  onClearAllSessions,
}: {
  open: boolean;
  onClose: () => void;
  cacheView: MobileHostCacheView | null;
  onSelectProject: (projectId: string) => void;
  onToggleProjectCache: (projectId: string, enabled: boolean) => void;
  onEnableAllCache: () => void;
  onClearProjectSessions: (projectId: string) => void;
  onClearAllSessions: () => void;
}) {
  const { t } = useI18n();
  if (!open) return null;
  const meta = cacheView?.meta ?? null;
  const projects = visibleAuthorizedProjects(cacheView);
  const stats = cacheView?.statsByProject ?? {};
  const hasAnySessions = Object.values(stats).some((entry) => entry.count > 0);
  return (
    <SettingsDialog
      placement="bottom"
      className="mobile-model-sheet mobile-cache-sheet"
      title={t("mobile.cache.title")}
      description={t("mobile.cache.description")}
      onClose={onClose}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <Button size="sm" variant="outline" disabled={!projects.length} onClick={onEnableAllCache}>
          {t("mobile.cache.enableAll")}
        </Button>
        <Button size="sm" variant="outline" disabled={!hasAnySessions} onClick={onClearAllSessions}>
          {t("mobile.cache.clearSessions")}
        </Button>
      </div>
      <div className="mobile-cache-list">
        {!projects.length ? (
          <p className="text-foreground-subtle">{t("mobile.cache.noAuthorized")}</p>
        ) : (
          projects.map((project) => {
            const name = projectDisplayName(project);
            const selected = meta?.selectedProjectId === project.projectId;
            const cacheEnabled =
              meta?.cachedProjectIds === null ||
              meta?.cachedProjectIds?.includes(project.projectId) === true;
            const projectStats = stats[project.projectId];
            return (
              <div
                key={project.projectId}
                className="mobile-cache-card"
                data-project-id={project.projectId}
                data-selected={selected}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  onClick={() => {
                    onSelectProject(project.projectId);
                    onClose();
                  }}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <Folder className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                    <span className="truncate">{name}</span>
                    {selected && (
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-fixed-caption text-primary">
                        {t("mobile.cache.current")}
                      </span>
                    )}
                  </span>
                  <span className="text-fixed-caption text-foreground-subtle">
                    {t(project.state === "ready" ? "mobile.cache.online" : "mobile.cache.offline")}
                    {" · "}
                    {t("mobile.cache.summaryCount", { count: project.summaries.items.length })}
                    {" · "}
                    {cacheEnabled
                      ? projectStats?.count
                        ? t("mobile.cache.cachedDetail", {
                            count: projectStats.count,
                            size: formatCacheBytes(projectStats.bytes),
                          })
                        : t("mobile.cache.cachedDetail", { count: 0, size: "0 KB" })
                      : t("mobile.cache.disabled")}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {projectStats?.count ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("mobile.cache.clearProject")}
                      title={t("mobile.cache.clearProject")}
                      onClick={() => onClearProjectSessions(project.projectId)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  ) : null}
                  <Switch
                    checked={cacheEnabled}
                    aria-label={t("mobile.cache.toggleLabel", { project: name })}
                    onCheckedChange={(checked) => onToggleProjectCache(project.projectId, checked)}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </SettingsDialog>
  );
}

const noopAction = (() => Promise.reject(new Error("OFFLINE"))) as Action;

export function OfflineCachedWorkspace({
  hostId,
  cacheStore,
  cacheView,
  connecting,
  onRetry,
  onOpenProjectSheet,
  onSelectProject,
}: {
  hostId: string;
  cacheStore: MobileCacheStore;
  cacheView: MobileHostCacheView | null;
  connecting: boolean;
  onRetry: () => void;
  onOpenProjectSheet: () => void;
  onSelectProject: (projectId: string, threadId?: string) => void;
}) {
  const { t } = useI18n();
  const [threadId, setThreadId] = useState<string>("");
  const [cachedSession, setCachedSession] = useState<SessionRead | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE);

  const projects = visibleAuthorizedProjects(cacheView);
  const activeProject =
    projects.find((p) => p.projectId === cacheView?.meta?.selectedProjectId) ?? projects[0];
  const cachedThreads = activeProject
    ? (cacheView?.cachedThreadIdsByProject[activeProject.projectId] ?? [])
    : [];

  useEffect(() => {
    setThreadId("");
    setCachedSession(null);
    setVisibleCount(SESSION_PAGE_SIZE);
  }, [activeProject?.projectId]);

  useEffect(() => {
    if (!activeProject || !threadId) {
      setCachedSession(null);
      return;
    }
    let live = true;
    setLoadingSession(true);
    void cacheStore
      .loadSession(hostId, activeProject.projectId, threadId)
      .then((entry) => {
        if (live) setCachedSession(entry ?? null);
      })
      .finally(() => {
        if (live) setLoadingSession(false);
      });
    return () => {
      live = false;
    };
  }, [cacheStore, hostId, activeProject?.projectId, threadId]);

  const summaries = [...(activeProject?.summaries.items ?? [])]
    .filter((item) => !item.desktop.archived)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const dark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

  let observationTurns: Data[] | null = null;
  if (cachedSession) {
    try {
      const mobileTurns = cachedSession.snapshot.mobileTurns;
      observationTurns = projectedTurns(
        Array.isArray(mobileTurns)
          ? mobileTurns
          : readObservationResult(cachedSession.snapshot).thread.turns,
      );
    } catch {
      observationTurns = null;
    }
  }

  return (
    <div className="mobile-offline-workspace" data-testid="mobile-offline-workspace">
      <FeedbackNotice
        tone="info"
        message={t(connecting ? "mobile.cache.connectingBanner" : "mobile.cache.offlineBanner")}
        actions={
          !connecting ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("mobile.retry")}
            </Button>
          ) : undefined
        }
      />
      {!activeProject ? (
        <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border p-4">
          <p className="text-foreground-subtle">{t("mobile.cache.noAuthorized")}</p>
        </div>
      ) : threadId ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="mobile-touch"
              onClick={() => setThreadId("")}
            >
              {t("mobile.cache.backToThreads")}
            </Button>
            <span className="truncate text-fixed-caption text-foreground-subtle">
              {projectDisplayName(activeProject)}
            </span>
          </div>
          {loadingSession ? (
            <p className="text-foreground-subtle">{t("mobile.loading")}</p>
          ) : observationTurns ? (
            <Messages
              project={{
                id: activeProject.projectId,
                root: activeProject.workspace,
                pending: [],
                models: [],
                core: { features: {} },
                state: { connected: false, queues: {}, interactions: {}, threads: {} },
              }}
              thread={{
                id: threadId,
                title: summaries.find((item) => item.id === threadId)?.name ?? "",
                turns: observationTurns,
                desktop: { archived: false },
              }}
              action={noopAction}
              dark={dark}
              readOnly
              reserveResponseSpace={false}
              readTurnReview={async () => ({})}
              onLink={(url) => {
                window.open(url, "_blank", "noopener,noreferrer");
              }}
              onFile={() => {}}
              onReview={() => {}}
            />
          ) : (
            <p className="text-foreground-subtle">{t("mobile.cache.notCachedDetail")}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <HardDrive className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
              <strong className="truncate">{projectDisplayName(activeProject)}</strong>
            </div>
            <Button size="sm" variant="outline" onClick={onOpenProjectSheet}>
              {t("mobile.cache.button")} ({projects.length})
            </Button>
          </div>
          {!summaries.length ? (
            <p className="text-foreground-subtle">{t("mobile.noSessions")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {summaries.slice(0, visibleCount).map((item) => {
                const isCached = cachedThreads.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-thread-id={item.id}
                    className="mobile-cache-card flex-col items-stretch text-left"
                    onClick={() => {
                      onSelectProject(activeProject.projectId, item.id);
                      setThreadId(item.id);
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">
                        {item.name || t("mobile.untitled")}
                      </span>
                      <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-fixed-caption text-foreground-subtle">
                        {t(isCached ? "mobile.cache.cachedBadge" : "mobile.cache.summaryOnlyBadge")}
                      </span>
                    </div>
                    {item.preview ? (
                      <span className="line-clamp-2 text-fixed-caption text-foreground-subtle">
                        {item.preview}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {summaries.length > visibleCount && (
                <Button
                  variant="ghost"
                  className="mobile-touch min-h-[var(--size-touch-target)]"
                  data-action="more-sessions"
                  onClick={() => setVisibleCount((count) => count + SESSION_PAGE_SIZE)}
                >
                  {t("mobile.olderSessions")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
