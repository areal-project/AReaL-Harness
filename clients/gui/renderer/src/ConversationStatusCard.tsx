import { useI18n } from "./i18n/IntlProvider.js";
import { errorText } from "./errors/errorCopy.js";
import { TaskContext } from "@areal/ui/experimental";
import { DelayedVisible } from "@areal/ui";
import "@areal/ui/conversation.css";
import { Button } from "./components/ui/button.js";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceChanges } from "./useWorkspaceChanges.js";
import { ScheduledTaskRow, ThreadScheduledTasks } from "./ScheduledTasks.js";
import { ReviewPanelIcon, TerminalPanelIcon, DocumentPanelIcon } from "./app-shell/panelIcons.js";
import { AgentsPane } from "./AgentsPane.js";
import { mediaOwner, SentAttachment } from "./MessageAttachment.js";
import type { MediaOwner } from "./PlatformReadContext.js";
import { verifiedFileReceipts } from "./TurnFileSummary.js";
import { LinkIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { ProjectFolderIcon } from "./homeChromeIcons.js";
import { ActivityIcon } from "./ActivityIcon.js";
import type { Action, Data, PlatformServices } from "./services.js";
import "./AgentResources.css";

export function ConversationStatusCard({
  project,
  thread,
  action,
  changes,
  onPanel,
  onAgent,
  onFile,
  scheduledTask,
  onAddSchedule,
  onOpenSchedule,
  onAgents,
  onAddSource,
  onLink,
  fileOpen,
}: {
  fileOpen?: PlatformServices["fileOpen"];
  project: Data;
  thread: Data;
  action: Action;
  changes: WorkspaceChanges;
  onPanel: (name: string) => void;
  onAgent: (id: string) => void;
  onFile: (path: string) => void;
  onAddSource?: () => void;
  onLink?: (url: string) => void;
  onAgents?: () => void;
  scheduledTask?: Data;
  onAddSchedule?: () => void;
  onOpenSchedule?: (task: Data) => void;
}) {
  const { t, intl } = useI18n();
  const [workspaceError, setWorkspaceError] = useState("");
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const [processes, setProcesses] = useState<Data[]>([]);
  const [processError, setProcessError] = useState("");
  const request = useRef(action);
  request.current = action;
  const { git, connected, files, additions, deletions, refresh } = changes;
  useEffect(() => {
    if (!connected || project.core?.features?.processes === false) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await request.current("manage", {
          projectId: project.id,
          threadId: thread.id,
          operation: "processes",
        });
        if (live) {
          setProcesses(value.data);
          setProcessError("");
        }
      } catch (cause) {
        if (live) setProcessError((cause as Error).message);
      }
      if (live) timer = setTimeout(read, 2000);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [project.id, thread.id, connected, project.core?.features?.processes]);
  const sources = [
    ...verifiedFileReceipts(
      (thread.turns ?? []).flatMap((turn: Data) =>
        (turn.items ?? []).filter((item: Data) => item.tool === "fs_read"),
      ),
    ).values(),
  ];
  // 附件字节按“哪一轮的哪条消息”向 Host 读取，所以每个附件带着它的出处。
  const attachments = [
    ...new Map<string, { part: Data; owner: MediaOwner }>(
      (thread.turns ?? []).flatMap((turn: Data) =>
        (turn.items ?? [])
          .filter((item: Data) => item.type === "userMessage")
          .flatMap((item: Data) =>
            (item.content ?? [])
              .filter(
                (part: Data) =>
                  ["image", "audio", "file"].includes(part.type) &&
                  typeof (part.url ?? part.uri) === "string",
              )
              .map((part: Data) => {
                const owner = mediaOwner(item, turn.id, thread.displayHistory?.viewGeneration);
                return [part.url ?? part.uri, { part, owner }] as [
                  string,
                  { part: Data; owner: MediaOwner },
                ];
              }),
          ),
      ),
    ).values(),
  ];
  const executionRoot = thread.worktree?.directory ?? git.info?.root ?? project.root;
  const worktree = !!(thread.worktree || git.info?.target);
  const workspaceName = project.projectless
    ? "独立任务"
    : project.name || project.root.split(/[\\/]/).pop();
  // Only explicit user links become inputs; this does not claim their pages were fetched.
  const links = new Set<string>();
  for (const turn of thread.turns ?? [])
    for (const item of turn.items ?? []) {
      if (item.type !== "userMessage") continue;
      for (const part of item.content ?? []) {
        if (part.type !== "text") continue;
        for (const match of String(part.text ?? "").matchAll(/https?:\/\/[^\s<>"\u3000]+/g))
          links.add(match[0].replace(/[).,;，。；）]+$/, ""));
      }
    }
  type Source = { id: string; part?: Data; owner?: MediaOwner; path?: string; url?: string };
  const entries: Source[] = [
    ...attachments.map(({ part, owner }) => ({ id: `media:${part.url ?? part.uri}`, part, owner })),
    ...sources.map((source) => ({ id: `file:${source.path}`, path: source.path })),
    ...[...links].map((url) => ({ id: `web:${url}`, url })),
  ];
  const renderSource = (entry: Source) =>
    entry.part ? (
      <SentAttachment
        part={entry.part}
        projectId={project.id}
        threadId={thread.id}
        action={action}
        compact
        mediaSource={entry.owner}
      />
    ) : entry.url ? (
      <TaskContext.Item
        title={entry.url}
        icon={<LinkIcon size={16} />}
        onClick={() => onLink?.(entry.url!)}
        disabled={!onLink}
      />
    ) : (
      <TaskContext.Item
        title={entry.path!.split("/").at(-1) || entry.path!}
        tooltip={entry.path}
        aria-label={entry.path}
        icon={<DocumentPanelIcon />}
        onClick={() => onFile(entry.path!)}
      />
    );
  return (
    <TaskContext
      embedded
      title={allSources ? t("chat.context.allSources") : workspaceName}
      onBack={allSources ? () => setAllSources(false) : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新任务资源"
          title="刷新任务资源"
          disabled={!connected || git.loading}
          onClick={refresh}
        >
          <RefreshCwIcon size={14} />
        </Button>
      }
    >
      <div hidden={allSources}>
        {!connected && (
          <p role="status" className="task-resource-note">
            连接不可用，资源可能已过期。
          </p>
        )}
        {git.error && (
          <p role="alert" className="task-resource-note">
            工作区改动读取失败：{git.error}
          </p>
        )}
        <DelayedVisible active={git.loading && !git.review}>
          <p role="status" className="task-resource-note">
            {t("chat.context.readingChanges")}
          </p>
        </DelayedVisible>
        {git.review && (
          <TaskContext.Section label={t("chat.context.changesRegion")}>
            <TaskContext.Item
              title={t("chat.context.changes")}
              aria-label={`${t("chat.context.changes")} · ${t("chat.context.changeScope", { count: files.length })} · +${intl.formatNumber(additions)} −${intl.formatNumber(deletions)}`}
              icon={<ReviewPanelIcon />}
              onClick={() => onPanel("改动")}
              meta={
                <span className="diff-count">
                  <b>+{intl.formatNumber(additions)}</b>
                  <em>−{intl.formatNumber(deletions)}</em>
                </span>
              }
            />
          </TaskContext.Section>
        )}
        <TaskContext.Section label={t("resources.workspace")}>
          <p className="task-resource-note">
            {t(
              thread.cloud
                ? "resources.cloud"
                : worktree
                  ? "resources.worktree"
                  : "resources.local",
            )}
          </p>
          <TaskContext.Item
            title={executionRoot}
            tooltip={executionRoot}
            icon={<ProjectFolderIcon />}
            aria-label={t("resources.openWorkspace")}
            disabled={!fileOpen || openingWorkspace || !!thread.cloud || !connected}
            onClick={() => {
              if (!fileOpen) return;
              setOpeningWorkspace(true);
              setWorkspaceError("");
              void fileOpen({
                operation: "open",
                projectId: project.id,
                threadId: thread.id,
                path: ".",
              })
                .catch((cause: Error) => setWorkspaceError(errorText(t, cause)))
                .finally(() => setOpeningWorkspace(false));
            }}
          />
          {git.info?.branch && (
            <TaskContext.Item
              title={`${t("resources.branch")} · ${git.info.branch}`}
              onClick={() => onPanel("改动")}
              icon={<ReviewPanelIcon />}
            />
          )}
          {workspaceError && (
            <p role="alert" className="task-resource-note">
              {workspaceError}
            </p>
          )}
        </TaskContext.Section>
        <AgentsPane
          key={`${project.id}:${thread.id}`}
          project={project}
          thread={thread}
          action={action}
          onOpen={onAgent}
          summary={{ onOpen: onAgents ?? (() => onPanel("子代理")) }}
        />
        {entries.length > 0 && (
          <TaskContext.Sources
            title={t("chat.context.sources")}
            collapseLabel={t("chat.context.collapseSources")}
            expandLabel={t("chat.context.expandSources")}
            items={entries}
            onViewAll={() => setAllSources(true)}
          >
            {renderSource}
          </TaskContext.Sources>
        )}
        {scheduledTask ? (
          <section
            className="task-resources-section"
            aria-label="定时任务安排"
            data-scheduled-task-card={scheduledTask.id}
            data-task-id={scheduledTask.id}
          >
            <h3 className="task-resources-heading">{t("operations.schedules.title")}</h3>
            <ScheduledTaskRow
              task={scheduledTask}
              project={project}
              action={action}
              variant="compact"
              disabled={scheduledTask.controlDisabled}
            />
          </section>
        ) : (
          <ThreadScheduledTasks
            project={project}
            thread={thread}
            action={action}
            hideWhenEmpty
            onOpen={onOpenSchedule}
          />
        )}
        {processError && (
          <p role="alert" className="task-resource-note">
            后台进程读取失败：{processError}
          </p>
        )}
        {processes.length > 0 && (
          <section className="task-resources-section" aria-label="后台进程">
            <h3 className="task-resources-heading">
              <span>后台进程</span>
              <span>
                {
                  processes.filter((process) => ["running", "accepted"].includes(process.state))
                    .length
                }{" "}
                个运行中
              </span>
            </h3>
            {processes.map((process) => (
              <Button
                unstyled
                data-slot={undefined}
                type="button"
                key={process.id}
                className="task-resource-row"
                onClick={() => onPanel("进程")}
                title={process.id}
              >
                <TerminalPanelIcon />
                <span className="task-resource-agent-body">
                  <span>
                    {(
                      {
                        accepted: "已受理",
                        running: "运行中",
                        failed: "启动失败",
                        closed: "已关闭",
                        unknown: "待确认",
                      } as Record<string, string>
                    )[process.state] ?? process.state}
                  </span>
                  <small className="task-resource-description">
                    {process.argv?.join(" ") || process.id}
                  </small>
                </span>
                <ActivityIcon kind="chevron" size={14} />
              </Button>
            ))}
          </section>
        )}
        {(onAddSource || onAddSchedule) && (
          <div className="task-resources-footer">
            {onAddSource && (
              <Button variant="ghost" size="sm" onClick={onAddSource}>
                <PlusIcon size={14} />
                {t("chat.context.addSource")}
              </Button>
            )}
            {onAddSchedule && (
              <Button variant="ghost" size="sm" onClick={onAddSchedule}>
                <PlusIcon size={14} />
                {t("chat.context.addSchedule")}
              </Button>
            )}
          </div>
        )}
      </div>
      {allSources && (
        <section aria-label={t("chat.context.sourceRegion")}>
          {entries.map((entry) => (
            <div key={entry.id}>{renderSource(entry)}</div>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setAllSources(false)}>
            {t("chat.context.backSources")}
          </Button>
        </section>
      )}
    </TaskContext>
  );
}
