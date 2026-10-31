import { useI18n } from "./i18n/IntlProvider.js";
import { Disclosure, TaskContext } from "@areal/ui/experimental";
import "@areal/ui/conversation.css";
import { Button } from "./components/ui/button.js";
import { useEffect, useRef, useState } from "react";
import { ScheduledTaskRow, ThreadScheduledTasks } from "./ScheduledTasks.js";
import { processItems, toolPresentation } from "./conversationPresentation.js";
import { ReviewPanelIcon, TerminalPanelIcon, DocumentPanelIcon } from "./app-shell/panelIcons.js";
import { AgentsPane } from "./AgentsPane.js";
import { SentAttachment } from "./MessageAttachment.js";
import { verifiedFileReceipts } from "./TurnFileSummary.js";
import { LinkIcon, RefreshCwIcon } from "lucide-react";
import { ProjectFolderIcon } from "./homeChromeIcons.js";
import { ActivityIcon } from "./ActivityIcon.js";
import type { Action, Data } from "./services.js";
import "./AgentResources.css";

export function ConversationStatusCard({
  project,
  thread,
  action,
  onPanel,
  onAgent,
  onFile,
  scheduledTask,
  onAddSchedule,
  onOpenSchedule,
  onAgents,
  onAddSource,
  onLink,
}: {
  project: Data;
  thread: Data;
  action: Action;
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
  const [allSources, setAllSources] = useState(false);
  const [git, setGit] = useState<Data>({ loading: true });
  const [processes, setProcesses] = useState<Data[]>([]);
  const [processError, setProcessError] = useState("");
  const [revision, refresh] = useState(0);
  const request = useRef(action);
  request.current = action;
  const turn = thread.turns?.at(-1);
  const tools = processItems(turn?.items ?? [], turn?.status).filter(
    (item: Data) => item.type === "dynamicToolCall" && !item.processOwnerId,
  );
  const checkpoint = JSON.stringify([
    turn?.id,
    turn?.status,
    tools
      .filter((item: Data) => !toolPresentation(item).running && !item.processUnsettled)
      .map((item: Data) => item.id),
  ]);
  const connected = thread.executionConnected ?? !!project.state?.connected;
  useEffect(() => {
    if (!connected) return;
    let live = true;
    setGit((previous) => ({ ...previous, loading: true }));
    void (async () => {
      try {
        const info = await request.current("workspace", {
          projectId: project.id,
          threadId: thread.id,
          operation: "info",
        });
        const review =
          !("git" in info) && info.head
            ? await request.current("workspace", {
                projectId: project.id,
                threadId: thread.id,
                operation: "review",
                scope: "unstaged",
              })
            : undefined;
        if (live) setGit({ info, review });
      } catch (cause) {
        if (live) setGit({ error: (cause as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [project.id, thread.id, connected, checkpoint, revision]);
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
  }, [project.id, thread.id, connected, revision, project.core?.features?.processes]);
  const files: Data[] = git.review?.files ?? [];
  const sources = [
    ...verifiedFileReceipts(
      (thread.turns ?? []).flatMap((turn: Data) =>
        (turn.items ?? []).filter((item: Data) => item.tool === "fs_read"),
      ),
    ).values(),
  ];
  const attachments: Data[] = [
    ...new Map<string, Data>(
      (thread.turns ?? []).flatMap((turn: Data) =>
        (turn.items ?? [])
          .filter((item: Data) => item.type === "userMessage")
          .flatMap((item: Data) =>
            (item.content ?? []).filter(
              (part: Data) =>
                ["image", "audio", "file"].includes(part.type) &&
                typeof (part.url ?? part.uri) === "string",
            ),
          )
          .map((part: Data) => [part.url ?? part.uri, part] as [string, Data]),
      ),
    ).values(),
  ];
  const total = (key: string) => files.reduce((sum, file) => sum + (file[key] ?? 0), 0);
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
  type Source = { id: string; part?: Data; path?: string; url?: string };
  const entries: Source[] = [
    ...attachments.map((part) => ({ id: `media:${part.url ?? part.uri}`, part })),
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
      title={allSources ? t("chat.context.allSources") : workspaceName}
      onBack={allSources ? () => setAllSources(false) : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新任务资源"
          title="刷新任务资源"
          disabled={!connected || git.loading}
          onClick={() => refresh((n) => n + 1)}
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
        {git.loading && !git.review && (
          <p role="status" className="task-resource-note">
            {t("chat.context.readingChanges")}
          </p>
        )}
        {git.review && (
          <TaskContext.Section label="工作区变更">
            <TaskContext.Item
              title={t("chat.context.changes")}
              aria-label={`${t("chat.context.changes")} · ${t("chat.context.changeScope", { count: files.length })} · +${intl.formatNumber(total("additions"))} −${intl.formatNumber(total("deletions"))}`}
              icon={<ReviewPanelIcon />}
              onClick={() => onPanel("改动")}
              meta={
                <span className="diff-count">
                  <b>+{intl.formatNumber(total("additions"))}</b>
                  <em>−{intl.formatNumber(total("deletions"))}</em>
                </span>
              }
            />
          </TaskContext.Section>
        )}
        {thread.worktree && (
          <TaskContext.Section label={t("chat.context.projects")}>
            <Disclosure
              label={workspaceName}
              textRole="interface"
              icon={<ProjectFolderIcon />}
              keepMounted
            >
              <p className="task-resource-note">{thread.worktree.sourceRoot}</p>
              <p className="task-resource-note">
                {thread.worktree.directory} · {thread.worktree.branch}
              </p>
            </Disclosure>
          </TaskContext.Section>
        )}
        <AgentsPane
          key={`${project.id}:${thread.id}`}
          project={project}
          thread={thread}
          action={action}
          onOpen={onAgent}
          summary={{ onOpen: onAgents ?? (() => onPanel("子代理")) }}
        />
        <TaskContext.Sources
          collapseLabel={t("chat.context.collapseSources")}
          expandLabel={t("chat.context.expandSources")}
          items={entries}
          onAdd={onAddSource}
          onViewAll={() => setAllSources(true)}
        >
          {renderSource}
        </TaskContext.Sources>
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
            onAdd={onAddSchedule}
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
