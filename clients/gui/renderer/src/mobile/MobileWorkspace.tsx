import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@areal/ui";
import { ChevronLeft, ChevronRight, Monitor, RotateCw, SquarePen } from "lucide-react";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { Messages } from "../Messages.js";
import { projectedTurns } from "../remote/session-projection.js";
import { ProjectFolderIcon } from "../homeChromeIcons.js";
import { useI18n, type MessageId } from "../i18n/IntlProvider.js";
import type { Action, CommandName, Data } from "../services.js";
import { MobileComposer } from "./MobileComposer.js";
import type { MobileClient } from "./mobile-client.mjs";
import type { MobileCommands } from "./mobile-commands.mjs";
import type { MobileWorkspace } from "./mobile-workspace.mjs";

function rowStatus(row: Data) {
  if (row.attentionRefs?.length) return "attention";
  if (
    ["running", "inProgress"].includes(row.execution?.state) ||
    ["running", "inProgress"].includes(row.execution?.runStatus)
  )
    return "running";
  if (
    [row.execution?.turnStatus, row.execution?.runStatus, row.execution?.state].includes("failed")
  )
    return "failed";
  return "idle";
}
const taskStatus: Record<string, MessageId> = {
  queued: "mobile.taskQueued",
  running: "mobile.status.running",
  waitingForInput: "mobile.status.attention",
  waitingForAgents: "mobile.taskWaiting",
  paused: "mobile.taskPaused",
  blocked: "mobile.taskBlocked",
  completed: "mobile.taskCompleted",
  failed: "mobile.status.failed",
  cancelled: "mobile.taskCancelled",
};
const dot = {
  attention: "bg-status-attention",
  running: "bg-status-running",
  failed: "bg-status-error",
  idle: "",
};
function Status({ row }: { row: Data }) {
  const { t } = useI18n();
  const status = rowStatus(row);
  return (
    <span className="mobile-status inline-flex gap-inline items-center text-foreground-subtle text-fixed-caption">
      {status !== "idle" && (
        <span
          aria-hidden="true"
          className={`mobile-status-dot inline-block size-[var(--size-status-dot)] [border-radius:var(--radius-pill)] w-[var(--size-status-dot)] h-[var(--size-status-dot)] rounded-[var(--radius-status-dot)] ${dot[status]}`}
        />
      )}
      {t(`mobile.status.${status}`)}
    </span>
  );
}
function Time({ value }: { value: string | number | null | undefined }) {
  const { locale } = useI18n();
  if (value === null || value === undefined) return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return null;
  return (
    <time className="text-foreground-subtle text-fixed-caption" dateTime={date.toISOString()}>
      {new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date)}
    </time>
  );
}
export function MobileWorkspaceView({
  workspace,
  client,
  commands,
  dismissComposerSheet,
}: {
  workspace: MobileWorkspace;
  client: MobileClient;
  commands: MobileCommands;
  dismissComposerSheet: React.RefObject<(() => void) | null>;
}) {
  const { t } = useI18n();
  const view = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const connection = useSyncExternalStore(client.subscribe, client.snapshot);
  const pull = useRef<number | null>(null);
  const page = view.page;
  const task = view.task;
  const [notice, setNotice] = useState(false);
  const action = useCallback(
    (async (name: CommandName, values: Data): Promise<Data> => {
      if (name !== "history") throw new Error(t("mobile.desktopOnly"));
      if (values.operation === "loadOlder") await workspace.older(values.pageId);
      else if (values.operation === "loadItem") workspace.bodies.retry();
      return {};
    }) as Action,
    [workspace, t],
  );
  const project =
    page.kind === "projects"
      ? null
      : view.projects.find((value) => value.projectId === page.projectId);
  const group = page.kind === "projects" ? null : view.groups[page.projectId];
  const title =
    page.kind === "session"
      ? view.detail?.snapshot.title || t("mobile.untitled")
      : page.kind === "task"
        ? view.task?.title || t("mobile.task")
        : project?.name || t("mobile.projects");
  const snapshot = view.detail?.snapshot;
  return (
    <TooltipProvider>
      <section
        className={`mobile-workspace relative [scrollbar-gutter:stable] [&>h3]:mt-inline [&_.messages-shell]:min-h-0 [&_.messages-shell]:flex-1 [&_.messages]:[scrollbar-gutter:auto]! [&_.messages]:[--content-font-size:var(--text-fixed-body)] [&_.message-column]:[--message-reading-inset:var(--spacing-inline)]! [&_>_h3]:text-fixed-label [&_>_h3]:text-foreground-subtle [&_>_h3]:font-normal min-h-0 flex-1 overflow-y-auto overscroll-y-contain mobile-stack flex flex-col gap-field ${["session", "new"].includes(page.kind) ? "mobile-session overflow-hidden! min-h-0" : ""}`}
        data-page={page.kind}
        aria-busy={view.loading}
        data-current-thread={page.kind === "session" ? page.threadId : undefined}
        onTouchStart={(event) => {
          if (event.currentTarget.scrollTop === 0 && page.kind !== "session")
            pull.current = event.touches[0].clientY;
        }}
        onTouchEnd={(event) => {
          const start = pull.current;
          pull.current = null;
          if (
            start !== null &&
            event.changedTouches[0].clientY - start >= event.currentTarget.clientHeight / 6
          )
            void workspace.refresh();
        }}
      >
        {page.kind === "projects" ? (
          <div className="mobile-page-heading shrink-0 [&_p]:mt-inline! [&_h2]:block [&_h2]:min-w-0 [&_h2]:max-w-full [&_h2]:truncate [&_h2]:text-fixed-page-title [&_p]:text-fixed-body [&_p]:text-foreground-subtle">
            <div className="mobile-heading-row flex items-center justify-between">
              <h2>{t("mobile.projects")}</h2>
              <Button
                variant="ghost"
                size="icon"
                className="mobile-icon-button size-[var(--size-touch-target)] min-h-[var(--size-touch-target)] p-inline"
                data-action="refresh"
                aria-label={t("mobile.refresh")}
                disabled={view.loading}
                onClick={() => void workspace.refresh()}
              >
                <RotateCw />
              </Button>
            </div>
            <p>{t("mobile.authorizedProjects", { count: view.projects.length })}</p>
          </div>
        ) : (
          <>
            <div
              className={`mobile-navigation flex items-center shrink-0 gap-inline min-h-[var(--size-touch-target)] ${page.kind === "work" ? "mobile-project-navigation justify-between" : ""}`}
            >
              <Button
                className="mobile-back-button h-auto min-h-[var(--size-touch-target)] p-0 gap-inline [&_svg]:size-[var(--spacing-field)]! text-fixed-body"
                variant="ghost"
                data-action="workspace-back"
                aria-label={t("mobile.back")}
                onClick={() => workspace.back()}
              >
                <ChevronLeft />
                {page.kind === "work" && <span>{t("mobile.projects")}</span>}
              </Button>
              {page.kind !== "work" && (
                <div className="mobile-navigation-copy flex-1 min-w-0 [&_h2]:block [&_h2]:min-w-0 [&_h2]:max-w-full [&_h2]:truncate [&_p]:block [&_p]:min-w-0 [&_p]:max-w-full [&_p]:truncate [&_h2]:text-fixed-emphasis [&_p]:text-fixed-caption [&_p]:text-foreground-subtle">
                  <h2 title={title}>{page.kind === "new" ? t("mobile.newConversation") : title}</h2>
                  <p title={project?.name}>{project?.name}</p>
                </div>
              )}
              {page.kind === "work" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="mobile-icon-button size-[var(--size-touch-target)] min-h-[var(--size-touch-target)] p-inline"
                  data-action="refresh"
                  aria-label={t("mobile.refresh")}
                  disabled={view.loading}
                  onClick={() => void workspace.refresh()}
                >
                  <RotateCw />
                </Button>
              )}
            </div>
            {page.kind === "work" && (
              <div className="mobile-page-heading shrink-0 [&_p]:mt-inline! [&_h2]:block [&_h2]:min-w-0 [&_h2]:max-w-full [&_h2]:truncate [&_h2]:text-fixed-page-title [&_p]:text-fixed-body [&_p]:text-foreground-subtle">
                <h2 title={title}>{title}</h2>
                <p>{t("mobile.runsOnComputer")}</p>
              </div>
            )}
          </>
        )}
        {notice && <p role="status">{t("mobile.desktopOnly")}</p>}
        {view.error && (
          <p
            className="mobile-read-feedback absolute top-[var(--size-touch-target)] inset-x-field z-1 bg-background text-fixed-caption"
            role="alert"
          >
            {t("mobile.readFailed")}
          </p>
        )}
        {view.loading && (
          <span className="sr-only" role="status">
            {t("mobile.loading")}
          </span>
        )}
        {page.kind === "projects" && (
          <div className="mobile-stack flex flex-col gap-field">
            {!view.projects.length && !view.loading && <p>{t("mobile.noProjects")}</p>}
            {view.projects.map((project) => {
              const rows = view.groups[project.projectId]?.data ?? [];
              const running = rows.filter((row: Data) => rowStatus(row) === "running").length;
              const attention = rows.reduce(
                (count: number, row: Data) => count + (row.attentionRefs?.length ?? 0),
                0,
              );
              const updated = rows
                .map((row: Data) => row.sourceUpdatedAt)
                .filter((value: unknown) => value !== null && value !== undefined)
                .sort()
                .at(-1);
              return (
                <Button
                  key={project.projectId}
                  className="mobile-project-card w-full gap-inline shadow-none border-0 h-auto whitespace-normal text-start justify-start p-field mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] bg-hover rounded-[var(--radius-card)]! text-foreground"
                  variant="ghost"
                  data-project-id={project.projectId}
                  aria-busy={
                    project.connectionState === "online" && !view.groups[project.projectId]
                  }
                  onClick={() => workspace.navigate({ kind: "work", projectId: project.projectId })}
                >
                  <span className="mobile-folder-icon grid place-items-center shrink-0 size-[var(--size-touch-target)] bg-background [border-radius:var(--radius-control)]">
                    <ProjectFolderIcon />
                  </span>
                  <span className="mobile-card-copy gap-[calc(var(--spacing-inline)/2)] [&>span:first-child]:block [&>span:first-child]:w-full [&>span:first-child]:min-w-0 [&>span:first-child]:max-w-full [&>span:first-child]:truncate [&_>_span:first-child]:text-fixed-control [&_>_span:first-child]:font-semibold [&_>_span:first-child]:[line-height:1.4] [&_>_span:not(:first-child)]:text-fixed-caption [&_>_span:not(:first-child)]:[line-height:1.4] [&_>_span:not(:first-child)]:text-foreground-subtle flex flex-1 min-w-0 flex-col items-start">
                    <span className="text-fixed-emphasis" title={project.name}>
                      {project.name}
                    </span>
                    <span className="text-fixed-caption text-foreground-subtle">
                      {project.connectionState === "online"
                        ? running || attention
                          ? t("mobile.projectSummary", { running, attention })
                          : t("mobile.projectIdle")
                        : t("mobile.projectOffline")}
                      {updated && (
                        <>
                          {" "}
                          · <Time value={updated} />
                        </>
                      )}
                    </span>
                  </span>
                  <ChevronRight
                    className="mobile-card-chevron size-[var(--spacing-field)]! text-foreground-subtle"
                    aria-hidden="true"
                  />
                </Button>
              );
            })}
          </div>
        )}
        {page.kind === "work" && (
          <>
            <Button
              className="mobile-touch h-[var(--size-touch-target)] min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] gap-inline [&_svg]:size-field!"
              data-action="new-session"
              disabled={
                connection.kind !== "connected" || !connection.ready.capabilities.includes("submit")
              }
              onClick={() => workspace.navigate({ kind: "new", projectId: page.projectId })}
            >
              <SquarePen />
              {t("mobile.newSession")}
            </Button>
            <h3 className="text-fixed-label text-foreground-subtle">{t("mobile.recent")}</h3>
            <div className="mobile-stack flex flex-col gap-field">
              {!group?.data.length && !view.loading && <p>{t("mobile.noSessions")}</p>}
              {(group?.data ?? []).map((row: Data) => (
                <Button
                  variant="ghost"
                  className="mobile-work-row w-full gap-inline shadow-none [border-radius:var(--radius-navigation)]! [&:hover]:bg-navigation-selected [&:focus-visible]:bg-navigation-selected h-auto whitespace-normal text-start justify-start p-inline mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                  key={row.kind === "taskRun" ? `${row.taskId}/${row.runId}` : row.threadId}
                  data-thread-id={row.threadId}
                  data-task-id={row.taskId}
                  onClick={() =>
                    workspace.navigate(
                      row.kind === "taskRun"
                        ? {
                            kind: "task",
                            projectId: page.projectId,
                            taskId: row.taskId,
                            runId: row.runId,
                          }
                        : { kind: "session", projectId: page.projectId, threadId: row.threadId },
                    )
                  }
                >
                  <span className="mobile-card-copy gap-[calc(var(--spacing-inline)/2)] [&>span:first-child]:block [&>span:first-child]:w-full [&>span:first-child]:min-w-0 [&>span:first-child]:max-w-full [&>span:first-child]:truncate [&_>_span:first-child]:text-fixed-control [&_>_span:first-child]:font-semibold [&_>_span:first-child]:[line-height:1.4] [&_>_span:not(:first-child)]:text-fixed-caption [&_>_span:not(:first-child)]:[line-height:1.4] [&_>_span:not(:first-child)]:text-foreground-subtle flex flex-1 min-w-0 flex-col items-start">
                    <span className="text-fixed-control" title={row.title || t("mobile.untitled")}>
                      {row.kind === "taskRun" && `${t("mobile.task")} · `}
                      {row.title || t("mobile.untitled")}
                    </span>
                    <span className="mobile-work-meta flex items-center flex-wrap gap-[calc(var(--spacing-inline)/2)]">
                      <Status row={row} />
                      <span aria-hidden="true">·</span>
                      <Time value={row.sourceUpdatedAt} />
                    </span>
                  </span>
                </Button>
              ))}
            </div>
            {group?.nextCursor && (
              <Button
                variant="ghost"
                className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                data-action="more-sessions"
                disabled={view.loading}
                onClick={() => void workspace.more()}
              >
                {t("mobile.olderSessions")}
              </Button>
            )}
          </>
        )}
        {page.kind === "session" && snapshot && (
          <>
            {view.bodyError && (
              <Button
                className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                variant="ghost"
                onClick={() => workspace.bodies.retry()}
              >
                {t("mobile.retryBody")}
              </Button>
            )}
            <Messages
              project={{
                id: page.projectId,
                root: "",
                models: snapshot.models ?? [],
                pending: [],
                core: { features: {} },
                state: { connected: true, queues: {}, interactions: {}, threads: {} },
              }}
              thread={{
                id: snapshot.threadId,
                title: snapshot.title,
                turns: projectedTurns(view.turns),
                goals: snapshot.goals,
                desktop: { archived: false },
                displayHistory: workspace.historyView(),
              }}
              action={action}
              dark={matchMedia("(prefers-color-scheme: dark)").matches}
              readOnly
              showTurnNavigation={false}
              reserveResponseSpace={false}
              onLink={() => setNotice(true)}
              onFile={() => setNotice(true)}
              onReview={() => setNotice(true)}
              readTurnReview={async () => {
                throw new Error(t("mobile.desktopOnly"));
              }}
            />
          </>
        )}
        {page.kind === "new" && (
          <div className="mobile-new-session min-h-0 p-section [&>svg]:size-[calc(var(--spacing-section)+var(--spacing-inline))] [&_h2]:max-w-full [&_h2]:truncate [&_>_svg]:text-foreground-subtle [&_h2]:text-fixed-section-title [&_p]:text-fixed-body [&_p]:leading-normal flex flex-1 flex-col items-center justify-center gap-field text-center">
            <Monitor aria-hidden="true" />
            <h2 className="text-fixed-section-title">
              {t("mobile.newPrompt", { project: project?.name ?? "" })}
            </h2>
            <p className="text-fixed-body text-foreground-subtle">{t("mobile.newDescription")}</p>
          </div>
        )}
        {["new", "session"].includes(page.kind) && (
          <MobileComposer
            client={client}
            workspace={workspace}
            commands={commands}
            dismissComposerSheet={dismissComposerSheet}
          />
        )}
        {page.kind === "projects" && (
          <p className="mobile-projects-footnote mt-auto! pt-section px-inline text-center text-fixed-caption leading-normal text-foreground-subtle">
            {t("mobile.projectAccessHint")}
          </p>
        )}
        {page.kind === "task" && task && (
          <div className="mobile-stack flex flex-col gap-field">
            <p>{t(taskStatus[task.runStatus] ?? "mobile.taskUnavailable")}</p>
            <p>{t("mobile.taskReadOnly")}</p>
            {task.threadId && (
              <Button
                className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                onClick={() =>
                  workspace.navigate({
                    kind: "session",
                    projectId: page.projectId,
                    threadId: task.threadId,
                  })
                }
              >
                {t("mobile.openSession")}
              </Button>
            )}
          </div>
        )}
      </section>
    </TooltipProvider>
  );
}
