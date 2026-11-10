import { DelayedVisible, Skeleton, TitleTooltip } from "@areal/ui";
import { errorText } from "./errors/errorCopy.js";
import { useI18n } from "./i18n/IntlProvider.js";
// Adapted from ZCode ToolSummaryRow / ToolLayout; Codex reference guides presentation.
// Core owns all outcomes.
import { readingDisclosure, rememberDisclosure } from "./conversationReading.js";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ActivityRow,
  ActivityRowButton,
  ActivityRowChevron,
  ActivityRowHint,
  ActivityRowStatus,
  ActivityRowText,
  ImageDisclosure,
} from "@areal/ui/experimental";
import "@areal/ui/conversation.css";
import { Collapsible } from "@base-ui/react/collapsible";
import { AgentAvatar, agentName, agentTask, spawnedAgent } from "./AgentIdentity.js";
import { ActivityIcon } from "./ActivityIcon.js";
import { agentSettlements, toolActionText, toolPresentation } from "./conversationPresentation.js";
import { CommandDetails } from "./CommandDetails.js";
import { ToolCallDuration } from "./ToolCallDuration.js";
import { Button } from "./components/ui/button.js";
import { verifiedFileReceipts } from "./TurnFileSummary.js";
import { DiffViewer } from "./components/ui/diff-viewer.js";
import { MessageActions } from "./MessageActions.js";
import { SentAttachment } from "./MessageAttachment.js";
import type { McpResultSource, McpResultState } from "./mcp-app-services.js";
import type { Action, Data } from "./services.js";
/** 文件和目录只显示末段名称；完整路径放在悬停提示里。 */
function fileName(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) || path;
}

export function ToolEvent({
  item,
  onFile,
  onAgent,
  agents,
  agentTaskOf,
  turnId,
  readTurnReview,
  action,
  projectId,
  threadId,
  onOpenResult,
  resultState,
  onLoadDetails,
  detailsLoading,
  detailsError,
  mediaGeneration,
}: {
  onLoadDetails?: () => Promise<void>;
  detailsLoading?: boolean;
  detailsError?: string;
  mediaGeneration?: string;
  onOpenResult?: (source: McpResultSource) => Promise<void>;
  resultState?: McpResultState;
  /** Accepted for host compatibility; running rows stay static (CONV-STATUS-01). */
  animate?: boolean;
  item: Data;
  onAgent?: (id: string) => void;
  agents?: Data;
  agentTaskOf?: (id: string) => string | undefined;
  onFile?: (path: string) => void;
  turnId?: string;
  readTurnReview?: (turnId: string, itemId?: string) => Promise<Data>;
  action?: Action;
  projectId?: string;
  threadId?: string;
}) {
  const { t } = useI18n();
  const readingKey = JSON.stringify([projectId, threadId, turnId, item.id, "tool"]);
  const [open, setOpen] = useState(() => readingDisclosure(readingKey) ?? false);
  const [hasOpened, setHasOpened] = useState(open);
  const [fetching, setFetching] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const loader = useRef(onLoadDetails);
  loader.current = onLoadDetails;
  const busy = useRef(false);
  const attempted = useRef(false);
  const pending = !!onLoadDetails;
  const requestDetails = useCallback(async () => {
    if (busy.current || !loader.current) return;
    busy.current = true;
    setFetching(true);
    setReadFailed(false);
    try {
      await loader.current();
    } catch {
      setReadFailed(true);
    } finally {
      busy.current = false;
      setFetching(false);
    }
  }, []);
  useEffect(() => {
    if (!open || !pending) {
      attempted.current = false;
      return;
    }
    if (attempted.current) return;
    attempted.current = true;
    void requestDetails();
  }, [open, pending, requestDetails]);
  const toggle = () => {
    setHasOpened(true);
    rememberDisclosure(readingKey, !open);
    setOpen(!open);
  };
  const [imageError, setImageError] = useState("");
  const [diffOpen, setDiffOpen] = useState(false);
  const [review, setReview] = useState<{
    itemId: string;
    diff?: string;
    file?: {
      path: string;
      additions: number;
      deletions: number;
      beforeText: string;
      afterText: string;
    };
    error?: string;
  }>();
  const recordId = useId();
  const diffId = useId();
  const view = toolPresentation(item);
  const childId = onAgent && spawnedAgent(item);
  const child = childId && agents?.[childId];
  const ownedChild =
    child?.id === childId && child?.parentThreadId === threadId ? child : undefined;
  const childTitle = ownedChild?.preview || agentTask(item) || (childId ? agentName(childId) : "");
  // The accepted spawn proves the child started; its finish is a separate event (agentSettlements).
  const settlements = onAgent ? agentSettlements(item) : [];
  const settledTitle = (id: string) => {
    const known = agents?.[id];
    return (
      (known?.id === id && known?.parentThreadId === threadId && known?.preview) ||
      agentTaskOf?.(id) ||
      agentName(id)
    );
  };
  const images: Data[] =
    item.status === "completed" && item.success === true
      ? (item.contentItems ?? []).filter(
          (part: Data) =>
            part.type === "arealMedia" && part.modality === "image" && part.media?.uri,
        )
      : [];
  const isCommand = ["run_command", "verify_command", "read_process", "terminate_process"].includes(
    item.tool,
  );
  const file =
    onFile && !view.failed && !view.running
      ? verifiedFileReceipts([item]).values().next().value
      : undefined;
  const readOnly = item.tool === "fs_read";
  useEffect(() => {
    setReview(undefined);
    setDiffOpen(false);
    if (!file || readOnly || !turnId || !readTurnReview) return;
    let active = true;
    void readTurnReview(turnId, item.id)
      .then((result) => {
        if (
          result.turnId !== turnId ||
          result.itemId !== item.id ||
          result.scope !== "tool" ||
          typeof result.diff !== "string" ||
          !Array.isArray(result.files) ||
          result.files.length > 1
        )
          throw Error("本次文件比较结果不完整");
        const change = result.files[0];
        if (
          change &&
          (change.path !== file.path ||
            typeof change.beforeText !== "string" ||
            typeof change.afterText !== "string" ||
            !Number.isSafeInteger(change.additions) ||
            change.additions < 0 ||
            !Number.isSafeInteger(change.deletions) ||
            change.deletions < 0)
        )
          throw Error("本次文件版本或行数无法验证");
        if (active) setReview({ itemId: item.id, diff: result.diff, file: change });
      })
      .catch((cause) => {
        if (active)
          setReview({
            itemId: item.id,
            error: errorText(t, cause),
          });
      });
    return () => {
      active = false;
    };
  }, [turnId, item.id, file?.path, readOnly, readTurnReview]);
  useEffect(() => {
    if (resultState?.message) {
      setHasOpened(true);
      setOpen(true);
    }
  }, [resultState?.message]);
  const eligibleResult =
    onOpenResult &&
    projectId &&
    threadId &&
    turnId &&
    item.execution?.interactiveResult === true &&
    item.status === "completed" &&
    item.success === true &&
    item.execution?.outcome === "succeeded" &&
    item.execution?.backend === "mcp";
  const current = review?.itemId === item.id ? review : undefined;
  const mediaSource = turnId
    ? {
        generation: mediaGeneration,
        turnId: item.historySource?.turnId ?? turnId,
        itemId: item.historySource?.itemId ?? item.id,
        sourceThreadId: item.historySource?.threadId,
      }
    : undefined;
  return (
    <Collapsible.Root
      open={open}
      className="tool-event"
      data-tool-id={item.id}
      data-tool-status={view.status}
    >
      {childId ? (
        <div className="agent-spawn-row agent-event-row" data-agent-event="started">
          <Button
            variant="ghost"
            className="agent-spawn-link"
            aria-label={t("chat.agent.openConversation", { id: childId })}
            title={childTitle}
            onClick={() => onAgent?.(childId)}
          >
            <AgentAvatar id={childId} size={14} />
            <span className="agent-spawn-title">{childTitle}</span>
            <span className="agent-spawn-status">{t("chat.agent.started")}</span>
          </Button>
          <Button
            variant="ghost"
            className="agent-spawn-record"
            aria-label={t("chat.activity.rawRecord")}
            aria-expanded={open}
            aria-controls={recordId}
            onClick={toggle}
          >
            <ActivityIcon
              kind="chevron"
              size={14}
              className={open ? "tool-chevron open" : "tool-chevron"}
            />
          </Button>
        </div>
      ) : settlements.length ? (
        <div className="agent-event-list">
          {settlements.map(({ threadId: id, label }, index) => (
            <div key={id} className="agent-spawn-row agent-event-row" data-agent-event="settled">
              <Button
                variant="ghost"
                className="agent-spawn-link"
                aria-label={t("chat.agent.openConversation", { id })}
                title={settledTitle(id)}
                onClick={() => onAgent?.(id)}
              >
                <AgentAvatar id={id} size={14} />
                <span className="agent-spawn-title">{settledTitle(id)}</span>
                <span className="agent-spawn-status">{label}</span>
              </Button>
              {index === 0 && (
                <Button
                  variant="ghost"
                  className="agent-spawn-record"
                  aria-label={t("chat.activity.rawRecord")}
                  aria-expanded={open}
                  aria-controls={recordId}
                  onClick={toggle}
                >
                  <ActivityIcon
                    kind="chevron"
                    size={14}
                    className={open ? "tool-chevron open" : "tool-chevron"}
                  />
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : images.length && action && projectId && threadId ? (
        <ActivityRow className="tool-summary-row tool-image-row">
          <ImageDisclosure
            label={t("chat.tool.images", { count: images.length })}
            state="available"
          >
            <div className="tool-image-preview">
              {images.map((part) => (
                <SentAttachment
                  mediaSource={mediaSource}
                  key={part.media.uri}
                  onError={setImageError}
                  part={{ type: "image", uri: part.media.uri, name: "工具图片" }}
                  projectId={projectId}
                  threadId={threadId}
                  action={action}
                />
              ))}
            </div>
          </ImageDisclosure>
          <Button
            unstyled
            data-slot={undefined}
            type="button"
            className="agent-spawn-record"
            aria-label={t("chat.activity.rawRecord")}
            aria-expanded={open}
            aria-controls={recordId}
            onClick={toggle}
          >
            <ActivityRowChevron open={open} />
          </Button>
        </ActivityRow>
      ) : file ? (
        <ActivityRow
          className="tool-summary-row tool-file-row"
          icon={<ActivityIcon kind={readOnly ? "read" : "edit"} />}
        >
          <span className="areal-activity-row-action">{toolActionText(item, "done", t)}</span>
          <ActivityRowHint hint={file.path}>
            <Button
              variant="ghost"
              className="tool-file-link"
              aria-label={t("chat.activity.openFile", { path: file.path })}
              onClick={() => onFile?.(file.path)}
            >
              {fileName(file.path)}
            </Button>
          </ActivityRowHint>
          {current && !current.error && (
            <Button
              variant="ghost"
              className="tool-file-diff-toggle"
              aria-label="查看本次文件更改"
              aria-expanded={diffOpen}
              aria-controls={diffId}
              onClick={() => setDiffOpen(!diffOpen)}
            >
              <span
                className="tool-file-stats"
                aria-label={`本次新增 ${current.file?.additions ?? 0} 行，删除 ${current.file?.deletions ?? 0} 行`}
              >
                +{current.file?.additions ?? 0} -{current.file?.deletions ?? 0}
              </span>
              <ActivityRowChevron open={diffOpen} />
            </Button>
          )}
          {current?.error && (
            <TitleTooltip title={current.error}>
              <span>
                <ActivityRowStatus>本次改动无法验证</ActivityRowStatus>
              </span>
            </TitleTooltip>
          )}
          <Button
            variant="ghost"
            className="tool-file-record"
            aria-label={t("chat.activity.rawRecord")}
            title={t("chat.activity.rawRecord")}
            aria-expanded={open}
            aria-controls={recordId}
            onClick={toggle}
          >
            <ActivityRowChevron open={open} />
          </Button>
        </ActivityRow>
      ) : (
        <ActivityRowButton
          type="submit"
          className="tool-summary-row"
          aria-expanded={open}
          onClick={toggle}
          icon={<ActivityIcon kind={view.icon} />}
        >
          <ActivityRowText
            action={toolActionText(
              item,
              view.running
                ? "running"
                : view.state === "completed" || view.failed
                  ? "done"
                  : "plain",
              t,
            )}
            detail={view.path ? fileName(view.path) : view.detail}
            detailHint={view.path ?? (view.detail || undefined)}
            running={view.running}
          />
          <ActivityRowStatus
            tone={view.failed ? "failed" : undefined}
            hidden={!view.failed && (view.state === "completed" || view.running)}
          >
            {view.failed && view.exitCode != null
              ? t("chat.activity.failedExit", { code: view.exitCode })
              : t("chat.activity.status", { state: view.state })}
          </ActivityRowStatus>
          <ActivityRowChevron open={open} />
        </ActivityRowButton>
      )}
      {eligibleResult && (
        <Button
          variant="ghost"
          disabled={resultState?.opening}
          onClick={() => void onOpenResult({ projectId, threadId, turnId, itemId: item.id })}
        >
          {resultState?.opening ? t("operations.openingResult") : t("operations.openResult")}
        </Button>
      )}
      {imageError && (
        <p role="status" className="tool-result tool-failed">
          {imageError}
        </p>
      )}
      {resultState?.message && (
        <p role="status" className="notice">
          {resultState.message}
        </p>
      )}
      {file && diffOpen && current && !current.error && (
        <div className="tool-file-diff" id={diffId} role="region" aria-label="本次文件更改">
          <div className="tool-file-diff-header">
            <Button
              variant="ghost"
              className="tool-file-link"
              aria-label={`打开 ${file.path}`}
              title={file.path}
              onClick={() => onFile?.(file.path)}
            >
              {file.path.split("/").at(-1)}
            </Button>
            <span className="text-diff-added">+{current.file?.additions ?? 0}</span>
            <span className="text-diff-removed">-{current.file?.deletions ?? 0}</span>
            <MessageActions text={current.diff ?? ""} noun="差异" />
          </div>
          {current.file ? (
            <DiffViewer
              oldFile={{ name: file.path, contents: current.file.beforeText }}
              newFile={{ name: file.path, contents: current.file.afterText }}
              disableWorkerPool
              themeType={document.documentElement.classList.contains("dark") ? "dark" : "light"}
              options={{
                enableLineSelection: false,
                enableGutterUtility: false,
                parseDiffOptions: { context: 1 },
                collapsedContextThreshold: 0,
              }}
            />
          ) : (
            <p className="p-3 text-ui-sm text-foreground-subtle">本次写入没有文本差异</p>
          )}
        </div>
      )}
      <Collapsible.Panel keepMounted className="conversation-disclosure command-motion-panel">
        {(open || hasOpened) &&
          (pending ? (
            <div className="tool-event-body min-h-12" aria-busy={fetching || !!detailsLoading}>
              {detailsError || readFailed ? (
                <div>
                  <p role="alert">{t("chat.history.detailsFailed")}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={fetching || detailsLoading}
                    onClick={() => void requestDetails()}
                  >
                    {t("chat.history.retryDetails")}
                  </Button>
                </div>
              ) : (
                <div role="status" aria-label={t("chat.history.loadingDetails")}>
                  <DelayedVisible active={fetching || !!detailsLoading}>
                    <Skeleton className="mb-2 h-3 w-2/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </DelayedVisible>
                  <span className="sr-only">{t("chat.history.loadingDetails")}</span>
                </div>
              )}
            </div>
          ) : isCommand ? (
            <CommandDetails item={item} />
          ) : (
            <div
              className="tool-event-body"
              id={recordId}
              role={file ? "region" : undefined}
              aria-label={file ? "工具原始记录" : undefined}
            >
              <div className="tool-event-heading tool-record-heading">
                <span>{item.tool}</span>
                <ToolCallDuration item={item} />
              </div>
              <pre aria-label="工具参数">{JSON.stringify(item.arguments, null, 2)}</pre>
              <pre aria-label="工具结果">
                {(item.contentItems ?? []).map((c: Data) => c.text ?? "").join("\n") ||
                  (view.running ? "等待工具输出…" : "无文本输出")}
              </pre>
              {!images.length &&
                action &&
                projectId &&
                threadId &&
                (item.contentItems ?? [])
                  .filter((c: Data) => c.type === "arealMedia" && c.modality === "image")
                  .map((c: Data) => (
                    <SentAttachment
                      mediaSource={mediaSource}
                      key={c.media.uri}
                      part={{ type: "image", uri: c.media.uri, name: "页面截图" }}
                      projectId={projectId}
                      threadId={threadId}
                      action={action}
                    />
                  ))}
              {item.execution?.exitCode != null && <small>退出码 {item.execution.exitCode}</small>}
            </div>
          ))}
      </Collapsible.Panel>
      {open && action && projectId && threadId && item.execution?.resultSnapshot?.uri && (
        <SentAttachment
          mediaSource={mediaSource}
          part={{ type: "file", uri: item.execution.resultSnapshot.uri, name: "原始结果" }}
          projectId={projectId}
          threadId={threadId}
          action={action}
        />
      )}
    </Collapsible.Root>
  );
}
