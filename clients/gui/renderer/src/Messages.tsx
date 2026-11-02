import { commandResourceLabel } from "./conversationPresentation.js";
import { useTranscriptSelection } from "./useTranscriptSelection.js";
import * as readingDom from "./conversationReadingDom.js";
import { MessageTime, ModelChanges, TurnRetries } from "./ConversationTimeline.js";
import {
  beginReadingRestore,
  changeReadingIntent,
  createReadingState,
  settleReadingRestore,
} from "./conversationReading.js";
import { observeResize } from "@areal/ui/observe-resize";
import { PendingMessageView } from "./UserMessageBody.js";
import {
  readingViews,
  cancelTurnStart,
  hydrateReadingViews,
  saveReadingViews,
  scheduleSaveReadingViews,
  type ResponseSpace,
} from "./readingViews.js";
import { usePendingMessage } from "./pendingMessage.js";
import type { ConversationSelectionReference } from "./conversationSelectionReference.js";
import { projectConversationContent, conversationContentToText } from "./conversationContent.js";
import { ConversationContentView } from "./ConversationContentView.js";
import { GenUiCard } from "./GenUiWorkspace.js";
import { submitMessage, sending, markSending } from "./Composer.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { WorktreeStatus } from "./WorktreeStatus.js";
import { TurnUsage } from "./TurnUsage.js";
import { mcpResultKey, type McpResultSource, type McpResultState } from "./mcp-app-services.js";
import { useForkHistory } from "./ForkHistory.js";
import { DeferredHistoryItem, useConversationHistory } from "./ConversationHistory.js";
import { UnknownToolInspection } from "./UnknownToolInspection.js";
import { showTurnStatus } from "./toolInspection.js";
import { TurnNavigation } from "./TurnNavigation.js";
import {
  executionOutcome,
  executionSegments,
  progressGroups,
  goalContinuationLabel,
  turnFailureMessage,
} from "./conversationPresentation.js";
import { progressAutoCollapse, TurnProgress } from "./TurnProgress.js";
import { TurnElapsed } from "./TurnElapsed.js";
import { ForkIcon } from "./interfaceIcons.js";
import { isOrdinaryConversation } from "./ordinaryConversation.js";
import { MessageActions } from "./MessageActions.js";
import { UserFeedback } from "./UserFeedback.js";
import { TurnHookStats } from "./TurnHookStats.js";
import { agentAssignment } from "./AgentIdentity.js";
import { ToolEvent } from "./ToolEvent.js";
import { TurnActivity, TurnExecution } from "./TurnExecution.js";
import { SentUserMessage } from "./SentUserMessage.js";
import {
  MemoTurn,
  turnContextStamp,
  turnIdentity,
  useLiveFunctions,
  withHistoryTopology,
} from "./conversationTurns.js";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TimelineBottomButton } from "./TimelineBottomButton.js";
import { Button } from "./components/ui/button.js";
import { toast } from "./components/ui/toast.js";
import { Popover, PopoverContent } from "./components/ui/popover.js";
import { MessageResponse } from "./components/ai-elements/message.js";
import { SentAttachment } from "./MessageAttachment.js";
import {
  WorkspaceFileCard,
  WorkspaceImage,
  isWorkspaceImagePath,
  opensOutside,
  workspaceFileCardType,
} from "./WorkspaceMedia.js";
import { latestScheduleItems, ScheduledTaskCards } from "./ScheduledTasks.js";
import { TurnFileSummary } from "./TurnFileSummary.js";
import type { Data, Action, PlatformServices } from "./services.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";
// Queue pauseReason "stopped" is Core's stop receipt. It stays separate from the turn status.
export function Messages({
  project,
  thread: localThread,
  action,
  dark,
  onLink,
  onFile,
  fileOpen,
  onReview,
  readTurnReview,
  beforeTurns,
  onAgent,
  onFork,
  onSideSelection,
  onAddSelection,
  responseActions,
  embedded = false,
  showTurnNavigation = true,
  readOnly = false,
  decisionShown = false,
  afterTurns,
  reserveResponseSpace = !embedded,
  onOpenResult,
  resultStates,
  onGenUiFollowUp,
}: {
  onGenUiFollowUp?: (prompt: string) => Promise<void>;
  onOpenResult?: (source: McpResultSource) => Promise<void>;
  resultStates?: Record<string, McpResultState>;
  embedded?: boolean;
  showTurnNavigation?: boolean;
  readOnly?: boolean;
  /** The host renders this thread's pending decision cards (Composer); the transcript tail then does not repeat the wait. */
  decisionShown?: boolean;
  afterTurns?: ReactNode;
  reserveResponseSpace?: boolean;
  beforeTurns?: ReactNode;
  onAgent?: (id: string) => void;
  onFork?: (turnId: string, anchor?: HTMLElement) => Promise<void>;
  responseActions?: (message: Data) => ReactNode;
  onSideSelection?: (
    selection: Data,
    text: string,
    anchor?: Data,
    reference?: ConversationSelectionReference,
  ) => void;
  onAddSelection?: (reference: ConversationSelectionReference) => void;
  project: Data;
  thread: Data;
  action: Action;
  dark: boolean;
  onLink: (url: string) => void;
  onFile: (path: string, line?: number) => void;
  /** Desktop file host for workspace images and file cards; absent for cloud and previews. */
  fileOpen?: PlatformServices["fileOpen"];
  onReview: (turnId: string) => void;
  readTurnReview: (turnId: string, itemId?: string) => Promise<Data>;
}) {
  const { t } = useI18n();
  const outgoing = usePendingMessage(`areal-gui:draft:${project.id}:${localThread.id}`);
  const outgoingVisible =
    !readOnly &&
    outgoing &&
    !(localThread.turns ?? []).some((turn: Data) =>
      (turn.items ?? []).some(
        (item: Data) => item.type === "userMessage" && !outgoing.previousUserIds.includes(item.id),
      ),
    );
  hydrateReadingViews();
  const inherited = useForkHistory(project.id, localThread, action);
  const history = useConversationHistory(project.id, localThread, action);
  const thread: Data = {
    ...localThread,
    turns: [...inherited.turns, ...withHistoryTopology(localThread)],
  };
  const inheritedIds = new Set(inherited.turns.map((turn) => turn.id));
  const creationAnchor =
    localThread.displayHistory?.complete === false ? undefined : localThread.turns?.[0]?.id;
  const ordinary = isOrdinaryConversation(localThread, project.configurations?.[localThread.id]);
  const editable =
    ordinary && !readOnly
      ? (localThread.turns ?? [])
          .flatMap((turn: Data) =>
            turn.continuedFromTurnId || goalContinuationLabel(turn)
              ? []
              : (turn.items ?? []).filter((item: Data) => item.type === "userMessage"),
          )
          .at(-1)?.id
      : undefined;
  const responseSpace = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const olderSentinel = useRef<HTMLDivElement>(null);
  const autoOlderIntent = useRef(false);
  const olderInFlight = useRef<object | undefined>(undefined);
  const scrollbarReading = useRef<number | undefined>(undefined);
  const touchReading = useRef<{ y: number; requested: boolean } | undefined>(undefined);
  const readingViewport = useRef<{ width: number; height: number } | undefined>(undefined);
  const owner = JSON.stringify([project.id, thread.id, embedded]);
  const reading = useRef(createReadingState(owner, history.generation));
  const [, refreshReading] = useState(0);
  const readingFrame = useRef<number | undefined>(undefined);
  const layoutReading = useRef<() => void>(() => {});
  const historyCurrent = useRef(history);
  historyCurrent.current = history;
  const retainedReading = useRef("");
  const latestTurnId = thread.turns?.at(-1)?.id;
  const latestUserId = thread.turns
    ?.at(-1)
    ?.items?.find((item: Data) => item.type === "userMessage")?.id;
  const turnStartRequest = readingViews.get(owner)?.pendingTurnStart;
  const latestSchedules = useMemo(() => latestScheduleItems(thread.turns ?? []), [thread.turns]);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<{ turnId: string; message: string } | null>(null);
  const {
    selectedSideText,
    setSelectedSideText,
    selectionIsCurrent,
    captureSideSelection,
    referenceFor,
    askAboutSelection,
    selectionOwner,
    selectionSnapshot,
  } = useTranscriptSelection({
    project,
    thread,
    container,
    onAddSelection,
    onSideSelection,
    readOnly,
  });
  const canFork =
    !!onFork &&
    project.core?.features?.forkPreview === true &&
    !thread.parentThreadId &&
    !thread.desktop?.archived &&
    (!thread.conversation || thread.conversation.kind === "fork");
  const unresolved = (turn: Data) =>
    (turn.items ?? []).some(
      (item: Data) =>
        item.type === "dynamicToolCall" &&
        (item.status === "inProgress" ||
          item.execution?.outcome === "running" ||
          item.execution?.hooks?.some((hook: Data) => hook.outcome === "running") ||
          item.execution?.plugin?.operations?.some((op: Data) => op.outcome === "running") ||
          (!item.execution?.inspection &&
            (item.execution?.outcome === "unknown" ||
              item.execution?.hooks?.some((hook: Data) => hook.outcome === "unknown") ||
              item.execution?.plugin?.operations?.some((op: Data) => op.outcome === "unknown")))),
    );
  const prefixIssue = (thread.turns ?? []).map((turn: Data) =>
    turn.status === "inProgress" || unresolved(turn) ? turn.id : "",
  );
  const activeOwner = useRef<string | undefined>(undefined);
  const seenTurn = useRef({ owner, id: latestTurnId });
  const reservation = useRef<ResponseSpace | undefined>(readingViews.get(owner)?.responseSpace);
  const [readingHistory, setReadingHistory] = useState(false);
  const rememberReading = () => {
    const element = container.current;
    if (
      !element ||
      !activeOwner.current ||
      reading.current.kind === "restoring" ||
      reading.current.kind === "blocked"
    )
      return;
    const pendingTurnStart = readingViews.get(activeOwner.current)?.pendingTurnStart;
    readingViews.delete(activeOwner.current);
    readingViews.set(activeOwner.current, {
      pendingTurnStart,
      top: element.scrollTop,
      following: reading.current.kind === "following",
      atTail: element.scrollHeight - element.scrollTop - element.clientHeight <= 1,
      responseSpace: reservation.current && { ...reservation.current },
      anchor: reading.current.kind === "following" ? undefined : readingDom.readingAnchor(element),
    });
    const anchor = readingViews.get(activeOwner.current)?.anchor;
    const identity = JSON.stringify([
      historyCurrent.current.generation,
      anchor?.turnId,
      anchor?.itemId,
    ]);
    if (identity !== retainedReading.current) {
      retainedReading.current = identity;
      reading.current = changeReadingIntent(
        reading.current,
        reading.current.kind === "following"
          ? { kind: "following", target: reading.current.target }
          : {
              kind: "holding",
              anchor,
              disclosure:
                reading.current.kind === "holding" ? reading.current.disclosure : undefined,
            },
      );
      void historyCurrent.current.retain(reading.current.revision, anchor ?? null).catch(() => {});
    } else if (reading.current.kind === "holding") reading.current = { ...reading.current, anchor };
    scheduleSaveReadingViews();
  };
  const releaseResponseSpace = () => {
    reservation.current = undefined;
    if (responseSpace.current) responseSpace.current.style.height = "0px";
  };
  const readHere = (control?: HTMLElement) => {
    cancelTurnStart(readingViews.get(owner)?.pendingTurnStart);
    const element = container.current;
    const anchor = element ? readingDom.readingAnchor(element) : undefined;
    reading.current = changeReadingIntent(reading.current, {
      kind: "holding",
      anchor,
      disclosure:
        control && element
          ? {
              control,
              offset: control.getBoundingClientRect().top - element.getBoundingClientRect().top,
            }
          : undefined,
    });
    void historyCurrent.current.retain(reading.current.revision, anchor ?? null).catch(() => {});
    rememberReading();
  };
  const updateReading = () => {
    const element = container.current;
    if (!element || reading.current.kind === "restoring") return;
    const space = reservation.current;
    const section = space && readingDom.responseSection(element, space.turnId, latestTurnId);
    const viewport = readingViewport.current;
    // Viewport/font reflow can queue scroll before resize reconciliation,
    // including natural first-turn history with no reserved response space.
    // Its clamped position must not overwrite the existing reading intent.
    if (
      viewport &&
      (element.clientWidth !== viewport.width || element.clientHeight !== viewport.height)
    )
      return;
    // A folded/completed turn can shrink and clamp scrollTop before the queued
    // resize reconciliation. That scroll is layout, not a reader departure.
    // Explicit wheel and bottom actions release the space before reaching here.
    if (
      space &&
      section &&
      Math.abs(section.getBoundingClientRect().height - space.contentHeight) > 0.5
    )
      return;
    const previous = readingViews.get(activeOwner.current ?? owner);
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    // Scrollbar, keyboard and turn navigation can leave the tail without a
    // wheel event. Release only on departure, not on layout-driven growth.
    const departed =
      !!reservation.current && !!previous && remaining > 1 && element.scrollTop < previous.top - 1;
    if (departed) releaseResponseSpace();
    // Releasing space can clamp this same navigation frame to the new tail.
    // Preserve its departure intent instead of immediately resuming following.
    const following =
      !(reading.current.kind === "holding" && reading.current.disclosure) &&
      !departed &&
      ((reading.current.kind === "following" && reading.current.target?.kind === "turnStart") ||
        (element.scrollHeight - element.scrollTop - element.clientHeight < 120 &&
          (reading.current.kind === "following" ||
            (!!previous && element.scrollTop > previous.top + 1))));
    if (following && reading.current.kind !== "following")
      reading.current = changeReadingIntent(reading.current, { kind: "following" });
    if (!following && reading.current.kind === "following")
      reading.current = changeReadingIntent(reading.current, {
        kind: "holding",
        anchor: readingDom.readingAnchor(element),
      });
    rememberReading();
    setReadingHistory(
      (reading.current.kind !== "following" || reading.current.target?.kind === "turnStart") &&
        element.scrollHeight - element.scrollTop - element.clientHeight >= 120,
    );
  };
  const loadOlder = async (pageId?: string) => {
    if (olderInFlight.current || localThread.displayHistory?.loadingOlder) return;
    autoOlderIntent.current = false;
    readHere();
    const request = {};
    olderInFlight.current = request;
    try {
      const state = reading.current;
      await history.retain(
        state.revision,
        state.kind === "holding" ? (state.anchor ?? null) : null,
      );
      if (reading.current.owner !== owner) return;
      await history.load(undefined, pageId);
    } finally {
      if (olderInFlight.current === request) {
        olderInFlight.current = undefined;
        // 读取期间继续上滑的意图留到投影提交后检查，不要求用户再滑一次。
        requestAnimationFrame(() => {
          if (reading.current.owner === owner) autoLoadCurrent.current();
        });
      }
    }
  };
  const autoLoadOlder = () => {
    const element = container.current;
    const display = localThread.displayHistory;
    if (
      !element ||
      !autoOlderIntent.current ||
      reading.current.kind === "following" ||
      history.failure ||
      !display?.supported ||
      display.complete ||
      display.loadingLatest ||
      display.latestTurnComplete === false ||
      display.loadingOlder ||
      olderInFlight.current ||
      element.scrollTop > element.clientHeight
    )
      return;
    void loadOlder();
  };
  const autoLoadCurrent = useRef(autoLoadOlder);
  autoLoadCurrent.current = autoLoadOlder;
  useEffect(() => {
    autoOlderIntent.current = false;
    olderInFlight.current = undefined;
    touchReading.current = undefined;
    const element = container.current;
    const sentinel = olderSentinel.current;
    if (embedded || !element || !sentinel) return;
    const observer = new IntersectionObserver(() => autoLoadCurrent.current(), {
      root: element,
      rootMargin: "100% 0px 0px 0px",
    });
    observer.observe(sentinel);
    const releaseScrollbar = () => {
      scrollbarReading.current = undefined;
    };
    window.addEventListener("pointerup", releaseScrollbar);
    window.addEventListener("pointercancel", releaseScrollbar);
    return () => {
      observer.disconnect();
      window.removeEventListener("pointerup", releaseScrollbar);
      window.removeEventListener("pointercancel", releaseScrollbar);
    };
  }, [
    owner,
    embedded,
    localThread.displayHistory?.supported,
    localThread.displayHistory?.viewGeneration,
  ]);
  const scheduleReading = () => {
    // 在分页或流式更新改变 DOM 前记录用户位置；下一帧只调度历史读取。
    updateReading();
    if (readingFrame.current !== undefined) return;
    readingFrame.current = requestAnimationFrame(() => {
      readingFrame.current = undefined;
      if (activeOwner.current !== owner) return;
      autoLoadCurrent.current();
    });
  };
  const requestOlderFromInput = () => {
    if (history.failure) return;
    autoOlderIntent.current = true;
    if (reading.current.kind === "following")
      reading.current = changeReadingIntent(reading.current, { kind: "holding" });
    scheduleReading();
  };
  const returnToBottom = () => {
    autoOlderIntent.current = false;
    reading.current = changeReadingIntent(reading.current, { kind: "following" });
    void historyCurrent.current.retain(reading.current.revision, null).catch(() => {});
    releaseResponseSpace();
    // Instant scrolling avoids interpreting smooth-scroll frames as a reader
    // leaving the tail. Reading navigation never submits or restores execution.
    container.current?.scrollTo({ top: container.current.scrollHeight });
    rememberReading();
    setReadingHistory(false);
    updateReading();
  };
  const renderImage = useCallback(
    (uri: string, name: string) =>
      /^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(uri) ? (
        <SentAttachment
          part={{ type: "image", uri, name: name || "回复图片" }}
          projectId={project.id}
          threadId={thread.id}
          action={action}
        />
      ) : fileOpen && isWorkspaceImagePath(uri) ? (
        <WorkspaceImage path={uri} alt={name} projectId={project.id} fileOpen={fileOpen} />
      ) : fileOpen && workspaceFileCardType(uri) ? (
        <WorkspaceFileCard
          path={uri}
          label={name}
          projectId={project.id}
          fileOpen={fileOpen}
          onOpen={onFile}
        />
      ) : null,
    [project.id, thread.id, action, fileOpen, onFile],
  );
  const renderFileCard = useCallback(
    (path: string, label: string) =>
      fileOpen && workspaceFileCardType(path) ? (
        <WorkspaceFileCard
          path={path}
          label={label}
          projectId={project.id}
          fileOpen={fileOpen}
          onOpen={onFile}
        />
      ) : null,
    [project.id, fileOpen, onFile],
  );
  const openReplyFile = useCallback(
    (path: string, line?: number) => {
      if (fileOpen && /\.html?$/i.test(path)) {
        void fileOpen({
          operation: "openHtml",
          projectId: project.id,
          threadId: thread.id,
          path,
        }).catch((error: unknown) =>
          toast(error instanceof Error ? error.message : String(error), "error"),
        );
        return;
      }
      if (fileOpen && opensOutside(path))
        void fileOpen({ operation: "open", projectId: project.id, path }).catch(() =>
          onFile(path, line),
        );
      else onFile(path, line);
    },
    [fileOpen, onFile, project.id, thread.id],
  );
  const sendGenUi = async (prompt: string) => {
    if (readOnly || !project.state?.connected || localThread.desktop?.archived)
      throw Error("Conversation unavailable");
    if (onGenUiFollowUp) return onGenUiFollowUp(prompt);
    if (
      localThread.conversation?.kind === "side" &&
      localThread.conversation.policy?.kind !== "sideExecutableV2"
    )
      throw Error("Side submission unavailable");
    const key = `areal-gui:draft:${project.id}:${localThread.id}`;
    if (
      sending.has(key) ||
      project.pending?.some((entry: Data) => entry.params?.threadId === localThread.id)
    )
      throw Error("Submission needs confirmation");
    markSending(key, true);
    try {
      await submitMessage(action, project.id, localThread.id, prompt, [], {
        appMessage: true,
        enqueue: !!localThread.turns?.some((turn: Data) => turn.status === "inProgress"),
      });
    } finally {
      markSending(key, false);
    }
  };
  const renderAgentMessage = (entry: Data, turn: Data, deferActions = false) => {
    if (!entry.text?.trim()) return null;
    const blocks = projectConversationContent(
      entry.text,
      turn.status === "completed",
      turn.status === "inProgress",
    );
    return (
      <div
        className={`assistant-message${deferActions ? " assistant-message-final" : ""}`}
        data-message-phase={entry.phase ?? "legacy"}
        data-side-item-id={entry.id}
        key={entry.id}
      >
        <ConversationContentView
          blocks={blocks}
          markdown={(text) => (
            <MessageResponse
              className="conversation-markdown"
              preserveLineBreaks
              streaming={
                turn.status === "inProgress" &&
                (entry.phase !== "commentary" ||
                  entry.id ===
                    turn.items?.findLast((item: Data) =>
                      ["agentMessage", "dynamicToolCall", "userMessage", "agentMedia"].includes(
                        item.type,
                      ),
                    )?.id)
              }
              theme={dark ? "dark" : "light"}
              onOpenExternalUrl={onLink}
              onOpenFileLink={openReplyFile}
              onRenderImage={renderImage}
              onRenderFileCard={renderFileCard}
              fileLinks
              webPreviews
            >
              {text}
            </MessageResponse>
          )}
          interactive={(part) =>
            !inheritedIds.has(turn.id) ? (
              <GenUiCard
                key={`${entry.id}:${part.offset}`}
                source={{
                  projectId: project.id,
                  threadId: localThread.id,
                  turnId: turn.id,
                  itemId: entry.id,
                  referenceOffset: part.offset,
                }}
                title={part.reference.title ?? t("genUi.title")}
                dark={dark}
                send={
                  readOnly || localThread.desktop?.archived || !project.state?.connected
                    ? undefined
                    : live.sendGenUi
                }
              />
            ) : (
              <p role="status">{t("genUi.unavailable")}</p>
            )
          }
        />
        <MessageTime createdAt={entry.createdAt} />
        {!deferActions && entry.phase !== "commentary" && turn.status !== "inProgress" && (
          <MessageActions text={conversationContentToText(blocks)} />
        )}
      </div>
    );
  };
  useLayoutEffect(() => {
    if (embedded) return;
    if (
      reading.current.owner === owner &&
      reading.current.generation === history.generation &&
      activeOwner.current === owner
    )
      return;
    const remembered = readingViews.get(owner);
    const previous = reading.current;
    reading.current = {
      ...createReadingState(owner, history.generation),
      revision: previous.revision + 1,
    };
    if (remembered?.following === false && remembered.anchor) {
      const request = beginReadingRestore(reading.current, remembered.anchor);
      reading.current = request;
      const local = (localThread.turns ?? []).some(
        (turn: Data) =>
          turn.id === request.anchor.turnId &&
          (turn.items ?? []).some(
            (item: Data) => item.id === request.anchor.itemId && item.type !== "historyDeferred",
          ),
      );
      const stale = localThread.displayHistory?.restoringItems?.includes(request.anchor.itemId);
      if (local && !stale) {
        reading.current = settleReadingRestore(reading.current, request, "ready");
        void history.retain(request.revision, request.anchor).catch(() => {});
      } else
        void history.ensure(request.revision, request.anchor).then((result) => {
          const next = settleReadingRestore(reading.current, request, result);
          if (next === reading.current) return;
          reading.current = next;
          refreshReading((value) => value + 1);
        });
    } else void history.retain(reading.current.revision, null).catch(() => {});
  }, [owner, history.generation, embedded]);
  useLayoutEffect(() => {
    const element = container.current,
      spacer = responseSpace.current;
    if (embedded || !element || !spacer) return;
    const previous = seenTurn.current;
    const switched = activeOwner.current !== owner;
    const remembered = readingViews.get(owner);
    const latest = thread.turns?.at(-1);
    const section = [...element.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
      (el) => el.dataset.turnId === latestTurnId,
    );
    const user = section?.querySelector<HTMLElement>(".user-message");
    if (switched) {
      reservation.current =
        reserveResponseSpace && remembered?.responseSpace
          ? { ...remembered.responseSpace }
          : undefined;
    }
    const requested = readingViews.get(owner)?.pendingTurnStart;
    const firstMountedTurn =
      !switched && !previous.id && latestTurnId && reading.current.kind === "following";
    const accepted =
      user &&
      !goalContinuationLabel(latest) &&
      ((requested && requested.afterTurnId !== latestTurnId) || firstMountedTurn);
    if (accepted) {
      cancelTurnStart(requested);
      reading.current = changeReadingIntent(reading.current, {
        kind: "following",
        target: { kind: "turnStart", turnId: latestTurnId },
      });
      reservation.current =
        reserveResponseSpace && section
          ? { turnId: latestTurnId, height: 0, contentHeight: 0 }
          : undefined;
    } else if (
      requested?.afterTurnId === latestTurnId &&
      readingDom.responseSection(element, readingDom.pendingTurnTarget)
    ) {
      // 点发送即定位待发消息，不等 Core 受理；受理后的真实消息出现在同一位置，不再跳动。
      reading.current = changeReadingIntent(reading.current, {
        kind: "following",
        target: { kind: "turnStart", turnId: readingDom.pendingTurnTarget },
      });
      reservation.current = { turnId: readingDom.pendingTurnTarget, height: 0, contentHeight: 0 };
    } else if (!switched && previous.id !== latestTurnId) reservation.current = undefined;
    // 自然流布局由父容器滚动；自身高度包含占位，
    // 用它计算预留空间会在下一次尺寸变化时形成反馈增长。
    if (!reserveResponseSpace) reservation.current = undefined;
    activeOwner.current = owner;
    seenTurn.current = { owner, id: latestTurnId };
    const layout = () => {
      const space = reservation.current;
      const reserved = space && readingDom.responseSection(element, space.turnId, latestTurnId);
      if (space && reserved?.querySelector(".user-message")) {
        const contentHeight = reserved.getBoundingClientRect().height;
        // Recompute from the live track: both response growth and input-area
        // collapse change layout. Neither first-paint size becomes history.
        space.height = Math.max(
          0,
          readingDom.responseTrackHeight(element, reserved) - contentHeight,
        );
        space.contentHeight = contentHeight;
        spacer.style.height = `${space.height}px`;
      } else spacer.style.height = "0px";
      const state = reading.current;
      const disclosure = state.kind === "holding" ? state.disclosure : undefined;
      if (disclosure && element.contains(disclosure.control)) {
        element.scrollTop +=
          disclosure.control.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          disclosure.offset;
      } else if (state.kind === "following") {
        const placed = readingDom.positionTurnStart(element, state.target?.turnId, latestTurnId);
        if (placed === "tail") reading.current = changeReadingIntent(state, { kind: "following" });
        if (placed !== "placed") element.scrollTop = element.scrollHeight;
      } else if (state.kind === "holding" && state.anchor)
        readingDom.restoreReadingAnchor(element, state.anchor);
      else if (state.kind === "restoring" && state.phase === "ready") {
        const result = readingDom.restoreReadingAnchor(element, state.anchor);
        if (result === true) {
          reading.current = {
            owner: state.owner,
            generation: state.generation,
            revision: state.revision,
            kind: "holding",
            anchor: state.anchor,
          };
        } else if (result === "pending") {
          // Markdown 的惰性模块尚未准入正文，尺寸变化后沿原锚点继续恢复。
        } else if (state.attempts >= 2) {
          reading.current = settleReadingRestore(state, state, "layout");
          refreshReading((value) => value + 1);
        } else {
          reading.current = { ...state, attempts: state.attempts + 1 };
          requestAnimationFrame(() => layoutReading.current());
        }
      }
      readingViewport.current = { width: element.clientWidth, height: element.clientHeight };
      setReadingHistory(
        (reading.current.kind !== "following" || reading.current.target?.kind === "turnStart") &&
          element.scrollHeight - element.scrollTop - element.clientHeight >= 120,
      );
      rememberReading();
    };
    if (switched && reading.current.kind !== "following") element.scrollTop = remembered?.top ?? 0;
    layoutReading.current = layout;
    const cancelPendingReading = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) ||
          (event.target instanceof Element &&
            event.target.closest("input, textarea, [contenteditable=true]")))
      )
        return;
      readHere();
    };
    const wheel = (event: WheelEvent) => {
      cancelPendingReading(event);
      if (event.deltaY >= 0 || element.scrollHeight <= element.clientHeight) return;
      if (reading.current.kind === "following")
        reading.current = changeReadingIntent(reading.current, { kind: "holding" });
      if (reservation.current) {
        const top = element.scrollTop;
        releaseResponseSpace();
        // Removing space clamps a tail scroll. Apply this one wheel movement
        // against its original anchor so releasing space adds no extra jump.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
        element.scrollTop = top + event.deltaY * unit;
        event.preventDefault();
        updateReading();
      }
    };
    // 回合完成时过程组自动收起：跟随底部的读者继续跟随；离开底部的读者以该过程标题为锚，
    // 标题已滚出视口时把它放到视口顶部，最终回答紧随其后，而不是被截断落在中间。
    const autoCollapse = (event: Event) => {
      const state = reading.current;
      if (state.kind !== "holding" || !state.anchor || !(event.target instanceof HTMLElement))
        return;
      const item = event.target.querySelector<HTMLElement>(
        `[data-side-item-id="${CSS.escape(state.anchor.itemId)}"]`,
      );
      if (!item) return;
      const control = event.target.querySelector<HTMLElement>(".turn-progress-summary");
      if (!control) return;
      reading.current = changeReadingIntent(reading.current, {
        kind: "holding",
        disclosure: {
          control,
          offset: Math.max(
            0,
            control.getBoundingClientRect().top - element.getBoundingClientRect().top,
          ),
        },
      });
    };
    element.addEventListener(progressAutoCollapse, autoCollapse);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("pointerdown", cancelPendingReading);
    element.addEventListener("keydown", cancelPendingReading);
    // File summaries, disclosures and Markdown/media resize independently of
    // Core snapshots. Reuse this reading owner; no new store or execution loop.
    // Resize notifications run before paint; a new frame exposes the old tail.
    const stopObserving = observeResize(
      element.firstElementChild ? [element, element.firstElementChild] : element,
      layout,
    );
    return () => {
      layoutReading.current = () => {};
      stopObserving();
      element.removeEventListener(progressAutoCollapse, autoCollapse);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", cancelPendingReading);
      element.removeEventListener("keydown", cancelPendingReading);
    };
  }, [owner, latestTurnId, latestUserId, turnStartRequest, reserveResponseSpace]);
  useLayoutEffect(() => {
    layoutReading.current();
  });
  useLayoutEffect(() => {
    return () => {
      if (readingFrame.current !== undefined) cancelAnimationFrame(readingFrame.current);
      readingFrame.current = undefined;
      // React 已替换子节点，清理时只保存最近一次已确认的阅读记录。
      saveReadingViews();
      reading.current = changeReadingIntent(reading.current, { kind: "holding" });
    };
  }, [owner]);
  const live = useLiveFunctions({
    loadOlder,
    readHere,
    releaseResponseSpace,
    rememberReading,
    renderAgentMessage,
    loadHistory: history.load,
    sendGenUi,
    onFork,
    onOpenResult,
    onFile,
    onAgent,
    readTurnReview,
    onReview,
    responseActions,
    onLink,
  });
  const turnStamp = turnContextStamp(
    project,
    localThread,
    [owner, dark, readOnly, decisionShown, embedded, canFork, forking, ordinary, editable],
    live,
  ).concat(
    JSON.stringify([
      creationAnchor,
      latestSchedules,
      resultStates,
      history.failure,
      history.generation,
      turnIdentity(t),
    ]),
  );
  return (
    <div className={embedded ? "messages-embedded" : "messages-shell"}>
      {!embedded && showTurnNavigation && (
        <TurnNavigation
          key={owner}
          turns={thread.turns ?? []}
          container={container}
          onNavigate={() => {
            readHere();
            releaseResponseSpace();
          }}
        />
      )}
      <div
        className={embedded ? "messages-embedded-content" : "messages"}
        ref={container}
        tabIndex={embedded ? undefined : 0}
        onScroll={
          embedded
            ? undefined
            : () => {
                const element = container.current;
                if (element && scrollbarReading.current !== undefined) {
                  if (element.scrollTop < scrollbarReading.current) requestOlderFromInput();
                  else if (element.scrollTop > scrollbarReading.current)
                    autoOlderIntent.current = false;
                  scrollbarReading.current = element.scrollTop;
                }
                scheduleReading();
              }
        }
        onWheelCapture={
          embedded
            ? undefined
            : (event) => {
                if (event.deltaY < 0) requestOlderFromInput();
                if (event.deltaY > 0) autoOlderIntent.current = false;
              }
        }
        onKeyDownCapture={
          embedded
            ? undefined
            : (event) => {
                if (
                  ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
                  (event.key === " " && event.shiftKey)
                ) {
                  if (
                    event.target instanceof Element &&
                    event.target.closest("input, textarea, [contenteditable=true]")
                  )
                    return;
                  requestOlderFromInput();
                } else if (["ArrowDown", "PageDown", "End", " "].includes(event.key))
                  autoOlderIntent.current = false;
              }
        }
        onPointerDownCapture={
          embedded
            ? undefined
            : (event) => {
                if (
                  event.pointerType !== "touch" &&
                  event.clientX >= event.currentTarget.getBoundingClientRect().right - 16
                )
                  scrollbarReading.current = event.currentTarget.scrollTop;
              }
        }
        onTouchStartCapture={
          embedded
            ? undefined
            : (event) => {
                const touch = event.touches[0];
                touchReading.current = touch ? { y: touch.clientY, requested: false } : undefined;
              }
        }
        onTouchMoveCapture={
          embedded
            ? undefined
            : (event) => {
                const gesture = touchReading.current;
                const touch = event.touches[0];
                if (!gesture || !touch) return;
                const delta = touch.clientY - gesture.y;
                if (delta < 0) autoOlderIntent.current = false;
                if (delta > 0 && !gesture.requested) {
                  gesture.requested = true;
                  requestOlderFromInput();
                }
                gesture.y = touch.clientY;
              }
        }
        onTouchEndCapture={() => {
          touchReading.current = undefined;
        }}
        onTouchCancelCapture={() => {
          touchReading.current = undefined;
          autoOlderIntent.current = false;
        }}
        onMouseUp={captureSideSelection}
        onKeyUp={(event) => {
          if (event.key !== "Escape" && event.key !== "Tab" && event.key !== "Enter")
            captureSideSelection();
        }}
        onClickCapture={(event) => {
          const control =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("button[aria-expanded], summary")
              : null;
          if (
            control &&
            event.currentTarget.contains(control) &&
            control.closest(".turn-progress, .turn-execution")
          )
            readHere(control);
        }}
      >
        <div className={embedded ? "message-column message-embedded-column" : "message-column"}>
          {localThread.displayHistory?.complete !== false &&
            !(localThread.turns ?? []).some((turn: Data) =>
              (turn.items ?? []).some((item: Data) => item.type === "userMessage"),
            ) && (
              <WorktreeStatus events={localThread.worktreeEvents} current={localThread.worktree} />
            )}
          {beforeTurns}
          <ModelChanges changes={thread.desktop?.modelChanges} />
          {inherited.loading && <p role="status">正在加载继承历史…</p>}
          {inherited.error && <p role="alert">继承历史读取失败：{inherited.error}</p>}
          {localThread.displayHistory?.supported && (
            <div ref={olderSentinel} className="message-history-controls" aria-live="polite">
              {localThread.displayHistory.loadingLatest ? (
                <span role="status">{t("chat.history.loadingLatest")}</span>
              ) : null}
            </div>
          )}
          {history.failure && !history.failure.itemId && (
            <div>
              <p role="alert">{history.failure.message}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={
                  localThread.displayHistory.loadingLatest ||
                  localThread.displayHistory.loadingOlder
                }
                onClick={() => void loadOlder()}
              >
                {t("recovery.retryView")}
              </Button>
            </div>
          )}
          {thread.desktop?.archived && (
            <p role="status" className="notice">
              此任务已归档，历史只读。
            </p>
          )}
          {(thread.turns ?? []).map((turn: Data, turnIndex: number) => {
            const isInherited = inheritedIds.has(turn.id);
            const earlierIssue = prefixIssue.slice(0, turnIndex).find(Boolean);
            const currentIssue = prefixIssue[turnIndex];
            const inspectTurn = earlierIssue || (turn.status === "inProgress" ? "" : currentIssue);
            return (
              <MemoTurn
                key={JSON.stringify([owner, turn.id])}
                turn={turn}
                stamp={`${turnStamp}${JSON.stringify([inspectTurn, isInherited, turn.id === latestTurnId, forkError?.turnId === turn.id && forkError?.message])}`}
                render={() => {
                  const forkReason = inspectTurn
                    ? "历史包含未结算或未核查的操作；请在来源核查或选择更早轮次"
                    : "";
                  const forkAt = (anchor: HTMLElement) => {
                    setForking(true);
                    setForkError(null);
                    void live
                      .onFork?.(turn.id, anchor)
                      .catch((cause: Error & { data?: { reason?: string } }) => {
                        const reason = cause.data?.reason;
                        const message =
                          reason === "TURN_NOT_TERMINAL"
                            ? "此轮仍在运行；请等待完成后重新分支。"
                            : reason === "HISTORY_UNRESOLVED"
                              ? "来源历史有未结算或未核查的操作；请在来源核查 UNKNOWN，或选择更早轮次。"
                              : reason === "ANCHOR_NOT_FOUND"
                                ? "轮次位置已变化；请刷新来源后重新选择。"
                                : cause.message;
                        setForkError({ turnId: turn.id, message });
                      })
                      .finally(() => setForking(false));
                  };
                  const forkControls = (
                    <>
                      {canFork && turn.status !== "inProgress" && (
                        <Button
                          unstyled
                          data-slot={undefined}
                          type="button"
                          className="turn-fork-trigger"
                          disabled={forking || !!forkReason}
                          title={forkReason || undefined}
                          aria-label="从此轮创建聊天分支"
                          aria-describedby={forkReason ? `fork-reason-${turn.id}` : undefined}
                          onClick={(event) => forkAt(event.currentTarget)}
                        >
                          <ForkIcon />
                          <span>分支</span>
                        </Button>
                      )}
                      {canFork && inspectTurn && turn.status !== "inProgress" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="side-bring-action"
                          aria-label={t("chat.selection.inspectSourceTurn")}
                          onClick={() =>
                            document
                              .querySelector<HTMLElement>(
                                `[data-turn-id="${CSS.escape(inspectTurn)}"]`,
                              )
                              ?.scrollIntoView({ block: "center" })
                          }
                        >
                          {t("chat.selection.inspectSource")}
                        </Button>
                      )}
                    </>
                  );
                  const segments = executionSegments(turn.items ?? [], turn.status);
                  const hasFinal = segments.some(
                    (item: Data) =>
                      item.type === "agentMessage" &&
                      item.phase === "final_answer" &&
                      item.text?.trim(),
                  );
                  const finalMessage = segments.findLast(
                    (item: Data) =>
                      item.type === "agentMessage" &&
                      item.phase === "final_answer" &&
                      item.text?.trim(),
                  );
                  // Old snapshots have no phases. A completed text-tail allows a purely
                  // chronological disclosure; it does not classify or rewrite any message.
                  // Unsettled work, pending input and terminal exceptions stay inspectable.
                  const tail = segments.at(-1);
                  const pendingInput = project.state?.interactions?.[thread.id]?.data?.some(
                    (item: Data) => item.status === "pending" && item.turnId === turn.id,
                  );
                  const legacyReply =
                    turn.status === "completed" &&
                    tail?.type === "agentMessage" &&
                    segments.every(
                      (item: Data) => item.type !== "agentMessage" || item.phase == null,
                    ) &&
                    !executionOutcome(segments.flatMap((item: Data) => item.items ?? []))
                      .unfinished &&
                    !pendingInput
                      ? tail
                      : undefined;
                  const responseMessage = finalMessage ?? legacyReply;
                  const hasReadingSummary = hasFinal || !!legacyReply;
                  // 带phase与旧快照共用同一过程总组；从运行期起保留挂载，
                  // 完成收敛只隐藏内容，不重置工具详情或改变历史顺序。
                  const groups = progressGroups(segments, turn.id, legacyReply?.id);
                  const firstProgress = groups.findIndex((group) => group.progress);
                  const initialUser = segments.find((item) => item.type === "userMessage");
                  const queue = project.state?.queues?.[thread.id];
                  const stopAccepted =
                    turn.status === "inProgress" &&
                    queue?.paused === true &&
                    queue?.pauseReason === "stopped";
                  const command = (turn.items ?? []).find(
                    (item: Data) => item.type === "dynamicToolCall" && item.tool === "run_command",
                  );
                  const resourceLabel =
                    command && queue?.pauseReason === "stopped" && turn.interruption !== "userPause"
                      ? commandResourceLabel(command)
                      : null;
                  const hasInterruption =
                    turn.status === "interrupted" ||
                    (turn.status === "failed" && !!turn.interruption);
                  const stopHeading = (
                    <div className="turn-stop-heading turn-progress-heading">
                      <div className="turn-progress-label">
                        <span className="turn-status turn-progress-summary" role="status">
                          {t(
                            turn.interruption === "userPause"
                              ? "chat.timeline.interruption.userPause"
                              : turn.interruption === "coreRecovery"
                                ? "chat.timeline.interruption.coreRecovery"
                                : "chat.timeline.interruption.other",
                          )}
                          {turn.error ? `：${turnFailureMessage(turn)}` : ""}
                        </span>
                      </div>
                      <div className="turn-progress-divider" />
                    </div>
                  );
                  return (
                    <section
                      key={JSON.stringify([owner, turn.id])}
                      data-turn-id={turn.id}
                      data-turn-status={turn.status}
                      data-latest-turn={turn.id === latestTurnId}
                    >
                      {stopAccepted && (
                        <p role="status">
                          {ordinary ? "暂停已受理，等待执行结算" : "停止已受理，等待执行结算"}
                        </p>
                      )}
                      {resourceLabel && <p role="status">{resourceLabel}</p>}
                      {groups.map((group, groupIndex) => {
                        const outcome = executionOutcome(
                          group.entries.flatMap(({ item }) => item.items ?? []),
                        );
                        const contents = group.entries.map(({ item }) => {
                          if (item.historyOmitted) return null;
                          if (item.type === "historyPageGap")
                            return (
                              <div key={item.id} className="notice" data-history-page-id={item.id}>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={localThread.displayHistory?.loadingOlder}
                                  onClick={() => void live.loadOlder?.(item.id)}
                                >
                                  {t("chat.history.reloadPage")}
                                </Button>
                              </div>
                            );
                          if (item.type === "historyDeferred")
                            return (
                              <DeferredHistoryItem
                                key={item.id}
                                item={item}
                                loading={localThread.displayHistory?.loadingItems?.[item.id]}
                                error={
                                  history.failure?.itemId === item.id
                                    ? history.failure?.message
                                    : undefined
                                }
                                onLoad={() => {
                                  live.readHere?.();
                                  void live.loadHistory?.(item.id);
                                }}
                              />
                            );
                          if (item.type === "questionAnswer")
                            return (
                              <div
                                className="user-message"
                                data-question-answer={item.id}
                                key={item.id}
                              >
                                <div className="user-message-content">
                                  <div className="user-bubble question-answer-bubble">
                                    {item.questions.map((question: Data) => (
                                      <div key={question.id}>
                                        <p className="question-answer-title">{question.title}</p>
                                        <p>{item.answers[question.id]}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            );
                          if (item.type === "userMessage") {
                            const continuation = turn.continuedFromTurnId
                              ? "继续执行"
                              : goalContinuationLabel(turn);
                            if (
                              continuation &&
                              item.id ===
                                turn.items?.find((entry: Data) => entry.type === "userMessage")?.id
                            ) {
                              return (
                                <div className="turn-status" key={item.id}>
                                  {continuation}
                                </div>
                              );
                            }
                            return (
                              <Fragment key={item.id}>
                                <SentUserMessage
                                  item={item}
                                  owner={owner}
                                  project={project}
                                  localThread={localThread}
                                  action={action}
                                  dark={dark}
                                  editable={item.id === editable}
                                  onLink={live.onLink}
                                  onFile={live.onFile}
                                  onExpand={() => {
                                    if (reading.current.kind === "following")
                                      reading.current = changeReadingIntent(reading.current, {
                                        kind: "holding",
                                      });
                                    live.releaseResponseSpace?.();
                                    live.rememberReading?.();
                                  }}
                                />
                                {turn.id === creationAnchor && item.id === initialUser?.id && (
                                  <WorktreeStatus
                                    events={localThread.worktreeEvents}
                                    current={localThread.worktree}
                                  />
                                )}
                              </Fragment>
                            );
                          }
                          if (item.type === "agentMessage")
                            return live.renderAgentMessage?.(
                              item,
                              turn,
                              item.id === finalMessage?.id,
                            );
                          if (item.type === "agentMedia")
                            return (
                              <div className="assistant-media flex flex-wrap gap-2" key={item.id}>
                                <SentAttachment
                                  part={{
                                    type: item.modality,
                                    uri: item.media.uri,
                                    name:
                                      item.modality === "image"
                                        ? "生成的图片"
                                        : item.modality === "audio"
                                          ? "生成的音频"
                                          : "生成的文件",
                                  }}
                                  projectId={project.id}
                                  threadId={thread.id}
                                  action={action}
                                />
                              </div>
                            );
                          return (
                            <TurnExecution
                              key={item.id}
                              readingKey={JSON.stringify([project.id, thread.id, turn.id, item.id])}
                              items={item.items}
                              turn={turn}
                              project={project}
                              threadId={thread.id}
                              renderItem={(entry: Data, disclosure) => {
                                if (entry.type === "historyPageGap")
                                  return (
                                    <Button
                                      key={entry.id}
                                      data-history-page-id={entry.id}
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => void live.loadOlder?.(entry.id)}
                                    >
                                      {t("chat.history.reloadPage")}
                                    </Button>
                                  );
                                if (entry.type === "dynamicToolCall")
                                  return (
                                    <div data-side-item-id={entry.id} key={entry.id}>
                                      <ToolEvent
                                        item={entry}
                                        {...disclosure}
                                        onOpenResult={
                                          (ordinary ||
                                            localThread.conversation?.policy?.kind ===
                                              "sideExecutableV2") &&
                                          !readOnly &&
                                          !isInherited &&
                                          !localThread.desktop?.archived
                                            ? live.onOpenResult
                                            : undefined
                                        }
                                        resultState={
                                          resultStates?.[
                                            mcpResultKey({
                                              projectId: project.id,
                                              threadId: thread.id,
                                              turnId: turn.id,
                                              itemId: entry.id,
                                            })
                                          ]
                                        }
                                        onFile={live.onFile}
                                        onAgent={isInherited ? undefined : live.onAgent}
                                        agents={isInherited ? undefined : project.state?.threads}
                                        agentTaskOf={(id) => agentAssignment(thread, id)}
                                        turnId={turn.id}
                                        action={action}
                                        projectId={project.id}
                                        threadId={thread.id}
                                        readTurnReview={
                                          turn.status === "completed"
                                            ? live.readTurnReview
                                            : undefined
                                        }
                                      />
                                    </div>
                                  );
                                if (entry.type === "modelContext") return null;
                                return (
                                  <SettingsDisclosure
                                    className="tool-call"
                                    data-side-item-id={entry.id}
                                    key={entry.id}
                                    title={entry.type}
                                  >
                                    <pre>{JSON.stringify(entry, null, 2)}</pre>
                                  </SettingsDisclosure>
                                );
                              }}
                            />
                          );
                        });
                        return (
                          <Fragment key={group.id}>
                            {group.progress ? (
                              <TurnProgress
                                readingKey={JSON.stringify([
                                  project.id,
                                  thread.id,
                                  turn.id,
                                  group.id,
                                ])}
                                summaryAvailable
                                turn={
                                  !thread.cloud && groupIndex === firstProgress ? turn : undefined
                                }
                                connected={!!project.state?.connected}
                                label={legacyReply ? "早前消息与活动" : "本轮过程"}
                                settled={
                                  turn.status === "completed" &&
                                  hasReadingSummary &&
                                  !outcome.unfinished &&
                                  !pendingInput
                                }
                                {...outcome}
                              >
                                {contents}
                              </TurnProgress>
                            ) : (
                              contents
                            )}
                            {group.entries.some(
                              ({ item }) => !thread.cloud && item === initialUser,
                            ) &&
                              firstProgress < 0 && (
                                <TurnElapsed turn={turn} connected={!!project.state?.connected} />
                              )}
                          </Fragment>
                        );
                      })}
                      {hasInterruption && stopHeading}
                      <TurnRetries turn={turn} />
                      {!isInherited &&
                        (turn.items ?? [])
                          .filter((item: Data) => item.type === "dynamicToolCall")
                          .map((item: Data) => (
                            <UnknownToolInspection
                              key={`${project.id}:${thread.id}:${item.id}`}
                              item={item}
                              project={
                                readOnly
                                  ? { ...project, state: { ...project.state, connected: false } }
                                  : project
                              }
                              thread={thread}
                              action={action}
                            />
                          ))}
                      <ScheduledTaskCards
                        items={turn.items ?? []}
                        project={project}
                        action={action}
                        latest={latestSchedules}
                      />
                      <TurnFileSummary
                        turn={turn}
                        readTurnReview={live.readTurnReview}
                        onFile={live.onFile}
                        onReview={live.onReview}
                      />
                      {responseMessage && turn.status !== "inProgress" ? (
                        <MessageActions
                          text={conversationContentToText(
                            projectConversationContent(
                              responseMessage.text,
                              turn.status === "completed",
                              false,
                            ),
                          )}
                        >
                          <TurnHookStats turn={turn} />
                          <TurnUsage
                            project={project}
                            thread={localThread}
                            turn={turn}
                            action={action}
                            inherited={isInherited}
                          />
                          {forkControls}
                          {live.responseActions?.(responseMessage)}
                          {!isInherited && !readOnly && (
                            <UserFeedback
                              project={project}
                              thread={localThread}
                              turn={turn}
                              item={responseMessage}
                              action={action}
                              dark={dark}
                            />
                          )}
                        </MessageActions>
                      ) : (
                        <div className="message-actions">
                          <TurnUsage
                            project={project}
                            thread={localThread}
                            turn={turn}
                            action={action}
                            inherited={isInherited}
                          />
                          {forkControls}
                        </div>
                      )}
                      <ModelChanges changes={thread.desktop?.modelChanges} afterTurnId={turn.id} />
                      {canFork && forkReason && turn.status !== "inProgress" && (
                        <p id={`fork-reason-${turn.id}`} className="notice">
                          {forkReason}
                        </p>
                      )}
                      {canFork && forkError?.turnId === turn.id && (
                        <p role="alert" className="notice">
                          {forkError?.message}
                        </p>
                      )}
                      {showTurnStatus(turn, hasInterruption, hasReadingSummary) && (
                        <div className="turn-status">
                          {(
                            {
                              completed: "已完成",
                              interrupted: "已停止",
                              failed: "执行失败",
                            } as Data
                          )[turn.status] ?? turn.status}
                          {turn.error ? `：${turnFailureMessage(turn)}` : ""}
                        </div>
                      )}
                      {!finalMessage &&
                        turn.status !== "inProgress" &&
                        turn.items?.some(
                          (item: Data) =>
                            item.type === "dynamicToolCall" && item.execution?.hooks?.length,
                        ) && (
                          <div className="message-actions">
                            <TurnHookStats turn={turn} />
                          </div>
                        )}
                      <TurnActivity
                        turn={turn}
                        project={project}
                        threadId={thread.id}
                        decisionShown={decisionShown}
                      />
                    </section>
                  );
                }}
              />
            );
          })}
          {outgoingVisible && (
            <PendingMessageView
              message={outgoing}
              fileReferenceRoot={localThread.worktree?.directory ?? project.root}
              theme={dark ? "dark" : "light"}
            />
          )}
          {afterTurns}
        </div>
        {!embedded && (
          <div ref={responseSpace} className="message-response-space" aria-hidden="true" />
        )}
      </div>
      {selectedSideText?.owner === selectionOwner && (onAddSelection || onSideSelection) && (
        <Popover
          open
          onOpenChange={(open) => {
            if (!open) setSelectedSideText(null);
          }}
        >
          <PopoverContent
            anchor={{ getBoundingClientRect: () => selectedSideText.rect }}
            side="top"
            initialFocus={false}
            finalFocus={false}
            data-testid="transcript-selection-actions"
            aria-label={t("chat.selection.actions")}
            className="w-auto flex-row gap-inline p-1"
            onMouseDown={(event) => event.preventDefault()}
          >
            {onAddSelection && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  const chosen = selectionSnapshot.current;
                  if (!chosen || !selectionIsCurrent(chosen)) return;
                  onAddSelection(referenceFor(chosen));
                  setSelectedSideText(null);
                }}
              >
                {t("chat.selection.addToChat")}
              </Button>
            )}
            {onSideSelection && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("chat.selection.askInSideChat")}
                onClick={() => void askAboutSelection()}
              >
                {t("chat.selection.ask")}
              </Button>
            )}
          </PopoverContent>
        </Popover>
      )}
      {!embedded && (
        <>
          {/* 时间线在 Composer 上沿渐隐，提示上方还有内容；不拦截指针（CONV-PROCESS-01）。 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-1 h-(--conversation-fade) bg-linear-to-b from-transparent to-background"
          />
          {/* 回看历史时显示“滚动到底部”入口。 */}
          <div className="timeline-float pointer-events-none absolute bottom-3 left-1/2 z-3 flex -translate-x-1/2 items-center gap-(--spacing-inline) *:pointer-events-auto">
            {readingHistory && <TimelineBottomButton onClick={returnToBottom} />}
          </div>
        </>
      )}
    </div>
  );
}
