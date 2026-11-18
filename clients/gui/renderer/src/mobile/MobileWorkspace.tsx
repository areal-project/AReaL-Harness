import { DelayedVisible } from "@areal/ui";
import { TitleTooltip } from "@areal/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@areal/ui";
import { ChevronLeft, ChevronRight, Settings, SquarePen } from "lucide-react";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { Messages } from "../Messages.js";
import { PendingMessageView } from "../UserMessageBody.js";
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
  onSettings,
  onSelection,
}: {
  workspace: MobileWorkspace;
  client: MobileClient;
  commands: MobileCommands;
  dismissComposerSheet: React.RefObject<(() => void) | null>;
  onSettings: () => void;
  onSelection: (projectId?: string, threadId?: string) => void;
}) {
  const { t } = useI18n();
  const view = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  useSyncExternalStore(commands.subscribe, commands.snapshot);
  const connection = useSyncExternalStore(client.subscribe, client.snapshot);
  const pull = useRef<number | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, { key?: string; offset: number; scrollTop: number }>());
  const page = view.page;
  const listId = page.kind === "work" ? page.projectId : undefined;
  const task = view.task;
  const selectedId =
    page.kind === "projects" ? undefined : workspace.cachedProject(page.projectId)?.projectId;
  const selectedThread = page.kind === "session" ? page.threadId : undefined;
  const selectionListener = useRef(onSelection);
  selectionListener.current = onSelection;
  useEffect(() => {
    selectionListener.current(selectedId, selectedThread);
  }, [selectedId, selectedThread]);
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
  const rows = group?.data;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const position = listId ? positions.current.get(listId) : undefined;
    const anchor =
      position?.key &&
      [...element.querySelectorAll<HTMLElement>("[data-work-row]")].find(
        (row) => row.dataset.workRow === position.key,
      );
    if (anchor && position) {
      element.scrollTop +=
        anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.offset;
    } else {
      element.scrollTop = position?.scrollTop ?? 0;
    }
  }, [page, listId, rows]);
  const title =
    page.kind === "session"
      ? view.detail?.snapshot.title || t("mobile.untitled")
      : page.kind === "task"
        ? view.task?.title || t("mobile.task")
        : project?.name || t("mobile.projects");
  const snapshot = view.detail?.snapshot;
  const outgoing =
    page.kind === "session" || page.kind === "new"
      ? commands.outgoingFor(
          page.projectId,
          page.kind === "session" ? page.threadId : "",
          view.turns,
        )
      : null;
  return (
    <TooltipProvider>
      <section
        ref={scroller}
        className={`mobile-workspace relative [scrollbar-gutter:stable] [&>h3]:mt-inline [&_.messages-shell]:min-h-0 [&_.messages-shell]:flex-1 [&_.messages]:[scrollbar-gutter:auto]! [&_.messages]:[--content-font-size:var(--text-fixed-body)] [&_.message-column]:[--message-reading-inset:var(--spacing-inline)]! [&_>_h3]:text-fixed-label [&_>_h3]:text-foreground-subtle [&_>_h3]:font-normal min-h-0 flex-1 overflow-y-auto overscroll-y-contain mobile-stack flex flex-col gap-field ${["session", "new"].includes(page.kind) ? "mobile-session overflow-hidden! min-h-0" : ""}`}
        data-page={page.kind}
        aria-busy={view.loading}
        data-current-thread={page.kind === "session" ? page.threadId : undefined}
        onScroll={(event) => {
          if (!listId) return;
          const element = event.currentTarget;
          const top = element.getBoundingClientRect().top;
          const anchor = [...element.querySelectorAll<HTMLElement>("[data-work-row]")].find(
            (row) => row.getBoundingClientRect().bottom > top,
          );
          positions.current.set(listId, {
            key: anchor?.dataset.workRow,
            offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
            scrollTop: element.scrollTop,
          });
        }}
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
          <header className="shrink-0">
            <div className="flex items-center justify-between gap-inline">
              <h2 className="text-fixed-page-title">{t("mobile.projects")}</h2>
              <Button
                variant="ghost"
                size="icon"
                className="mobile-touch size-[var(--size-touch-target)]"
                data-action="settings"
                aria-label={t("mobile.settings")}
                onClick={onSettings}
              >
                <Settings />
              </Button>
            </div>
            <p className="flex items-center gap-inline text-fixed-caption text-foreground-subtle">
              <span
                aria-hidden="true"
                className="inline-block size-[var(--size-status-dot)] rounded-[var(--radius-pill)] bg-success"
              />
              {t("mobile.hostOnline")}
            </p>
          </header>
        ) : (
          <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-inline">
            <Button
              variant="ghost"
              className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] max-w-full justify-self-start gap-0 px-0 text-fixed-control"
              data-action="workspace-back"
              onClick={() => workspace.back()}
            >
              <ChevronLeft aria-hidden="true" />
              <span className="truncate">
                {t(page.kind === "work" ? "mobile.projects" : "mobile.sessions")}
              </span>
            </Button>
            <div className="min-w-0 text-center">
              <h2 className="truncate text-fixed-emphasis">
                {page.kind === "new" ? t("mobile.newConversation") : title}
              </h2>
              {page.kind !== "work" && (
                <p className="truncate text-fixed-caption text-foreground-subtle">
                  {project?.name}
                </p>
              )}
            </div>
            {page.kind === "work" && (
              <Button
                className="mobile-touch min-h-[var(--size-touch-target)] justify-self-end gap-inline"
                data-action="new-session"
                disabled={
                  connection.kind !== "connected" ||
                  !connection.ready.capabilities.includes("submit")
                }
                onClick={() => void workspace.navigate({ kind: "new", projectId: page.projectId })}
              >
                <SquarePen />
                {t("mobile.newShort")}
              </Button>
            )}
          </header>
        )}
        {notice && <p role="status">{t("mobile.desktopOnly")}</p>}
        {view.error && (
          <div className="flex shrink-0 items-center justify-between gap-inline text-fixed-caption">
            <p role="alert">{t("mobile.readFailed")}</p>
            <Button variant="ghost" onClick={() => void workspace.refresh()}>
              {t("mobile.refresh")}
            </Button>
          </div>
        )}
        <DelayedVisible active={view.loading}>
          <span className="sr-only" role="status">
            {t("mobile.loading")}
          </span>
        </DelayedVisible>
        {page.kind === "projects" && (
          <div className="mobile-stack flex flex-col gap-field">
            {!view.projects.length && !view.loading && !view.error && (
              <p>{t("mobile.noProjects")}</p>
            )}
            {view.projects.map((project) => {
              return (
                <Button
                  key={project.projectId}
                  className="mobile-project-card w-full gap-inline shadow-none h-auto whitespace-normal text-start justify-start p-field mobile-touch min-h-[var(--size-touch-target)] rounded-none! border-b border-border text-foreground"
                  variant="ghost"
                  data-project-id={project.projectId}
                  aria-busy={
                    project.connectionState === "online" && !view.groups[project.projectId]
                  }
                  onClick={() => workspace.navigate({ kind: "work", projectId: project.projectId })}
                >
                  <span className="mobile-folder-icon grid place-items-center shrink-0 size-[var(--size-touch-target)] text-foreground-subtle">
                    <ProjectFolderIcon />
                  </span>
                  <span className="mobile-card-copy gap-[calc(var(--spacing-inline)/2)] [&>span:first-child]:block [&>span:first-child]:w-full [&>span:first-child]:min-w-0 [&>span:first-child]:max-w-full [&>span:first-child]:truncate [&_>_span:first-child]:text-fixed-control [&_>_span:first-child]:font-semibold [&_>_span:first-child]:[line-height:1.4] [&_>_span:not(:first-child)]:text-fixed-caption [&_>_span:not(:first-child)]:[line-height:1.4] [&_>_span:not(:first-child)]:text-foreground-subtle flex flex-1 min-w-0 flex-col items-start">
                    <TitleTooltip title={project.name}>
                      <span className="text-fixed-emphasis">{project.name}</span>
                    </TitleTooltip>
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
            <h3 className="text-fixed-label text-foreground-subtle">{t("mobile.recent")}</h3>
            <div className="mobile-stack flex flex-col gap-field">
              {!group?.data.length && !view.loading && !view.error && (
                <p>{t("mobile.noSessions")}</p>
              )}
              {(group?.data ?? []).map((row: Data) => (
                <Button
                  variant="ghost"
                  className="mobile-work-row w-full gap-inline shadow-none [border-radius:var(--radius-navigation)]! hover:bg-navigation-selected focus-visible:bg-navigation-selected active:bg-navigation-selected h-auto whitespace-normal text-start justify-start p-inline mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                  key={row.kind === "taskRun" ? `${row.taskId}/${row.runId}` : row.threadId}
                  data-thread-id={row.threadId}
                  data-task-id={row.taskId}
                  data-work-row={
                    row.kind === "taskRun" ? `${row.taskId}/${row.runId}` : row.threadId
                  }
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
                    <TitleTooltip title={row.title || t("mobile.untitled")}>
                      <span className="text-fixed-control">
                        {row.kind === "taskRun" && `${t("mobile.task")} · `}
                        {row.title || t("mobile.untitled")}
                      </span>
                    </TitleTooltip>
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
        {(page.kind === "session" || page.kind === "new") && (snapshot || outgoing) && (
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
                models: snapshot?.models ?? [],
                pending: [],
                core: { features: {} },
                state: { connected: true, queues: {}, interactions: {}, threads: {} },
              }}
              thread={{
                id: page.kind === "session" ? page.threadId : "",
                title: snapshot?.title,
                turns: projectedTurns(view.turns),
                goals: snapshot?.goals,
                desktop: { archived: false },
                displayHistory: snapshot ? workspace.historyView() : undefined,
              }}
              afterTurns={
                outgoing && (
                  <PendingMessageView
                    message={{ text: outgoing.text, files: [], previousUserIds: [] }}
                    status={
                      outgoing.turnId
                        ? "mobile.thinking"
                        : outgoing.reconnecting
                          ? "mobile.sendReconnecting"
                          : undefined
                    }
                    theme={matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"}
                  />
                )
              }
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
        {page.kind === "new" && !outgoing && (
          <div className="mobile-new-session min-h-0 p-section [&>svg]:size-[calc(var(--spacing-section)+var(--spacing-inline))] [&_h2]:max-w-full [&_h2]:truncate [&_>_svg]:text-foreground-subtle [&_h2]:text-fixed-section-title [&_p]:text-fixed-body [&_p]:leading-normal flex flex-1 flex-col items-center justify-center gap-field text-center">
            <h2 className="text-fixed-section-title">{t("mobile.newPromptSimple")}</h2>
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
