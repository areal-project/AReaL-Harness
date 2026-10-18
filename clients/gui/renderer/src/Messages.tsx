import { useForkHistory } from "./ForkHistory.js";
import { UnknownToolInspection } from "./UnknownToolInspection.js";
import { TurnNavigation } from "./TurnNavigation.js";
import { executionOutcome, executionSegments, goalContinuationLabel, turnFailureMessage } from "./conversationPresentation.js";
import { TurnProgress } from "./TurnProgress.js";
import { TurnElapsed, completedTimeLabel } from "./TurnElapsed.js";
import { ForkIcon, MoreOptionsIcon } from "./interfaceIcons.js";
import { MessageActions } from "./MessageActions.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
import { TurnHookStats } from "./TurnHookStats.js";
import { ToolEvent } from "./ToolEvent.js";
import { TurnExecution } from "./TurnExecution.js";
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { TimelineBottomButton } from "./TimelineBottomButton.js";
import { MessageResponse } from "./components/ai-elements/message.js";
import { SentAttachment } from "./MessageAttachment.js";
import { sentReviewFeedback } from "./reviewComments.js";
import { SentBrowserAnnotations } from "./BrowserAnnotationAttachments.js";
import { sentBrowserAnnotations } from "./browserAnnotations.js";
import { SentReviewComments } from "./ReviewCommentViews.js";
import { TurnFileSummary } from "./TurnFileSummary.js";
import type { Data, Action } from "./services.js";
// Like the existing file/Diff view caches, this is process-local GUI state.
// It owns no history or execution and intentionally disappears on restart.
type ResponseSpace = { turnId: string; height: number; contentHeight: number };
const readingViews = new Map<string, { top: number; following: boolean; atTail: boolean; responseSpace?: ResponseSpace }>();
// Queue pauseReason "stopped" is Core's stop receipt. It stays separate from the turn status.
function commandResourceLabel(tool: Data) {
  const outcome = tool.execution?.outcome;
  if (tool.status === "inProgress" || outcome === "running") return "命令资源仍在运行";
  if (outcome === "unknown" || outcome === "pending") return "命令资源结果待确认";
  if (outcome === "failed" || outcome === "error" || tool.success === false) return "命令资源失败";
  if (outcome === "interrupted" || outcome === "cancelled") return "命令资源已停止";
  if (outcome === "succeeded" || outcome === "success") return "命令资源已结束";
  return null;
}
export function Messages({
  project,
  thread: localThread,
  action,
  dark,
  onLink,
  onFile,
  onReview,
  readTurnReview,
  beforeTurns,
  onAgent,
  onFork,
  onSideSelection,
  responseActions,
  reserveResponseSpace = true,
}: {
  reserveResponseSpace?: boolean;
  beforeTurns?: ReactNode;
  onAgent?: (id: string) => void;
  onFork?: (turnId: string, boundary: "before" | "after", anchor?: HTMLElement) => Promise<void>;
  responseActions?: (message: Data) => ReactNode;
  onSideSelection?: (selection: Data, text: string, anchor?: Data) => void;
  project: Data;
  thread: Data;
  action: Action;
  dark: boolean;
  onLink: (url: string) => void;
  onFile: (path: string) => void;
  onReview: (turnId: string) => void;
  readTurnReview: (turnId: string, itemId?: string) => Promise<Data>;
}) {
  const inherited = useForkHistory(project.id, localThread, action);
  const thread: Data = { ...localThread, turns: [...inherited.turns, ...(localThread.turns ?? [])] };
  const inheritedIds = new Set(inherited.turns.map(turn => turn.id));
  const responseSpace = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const readingViewport = useRef<{ width: number; height: number } | undefined>(undefined);
  const owner = JSON.stringify([project.id, thread.id]);
  const latestTurnId = thread.turns?.at(-1)?.id;
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<{ turnId: string; message: string } | null>(null);
  const selectionOwner = JSON.stringify([project.core?.instanceId, project.id, thread.id]);
  const currentSelectionOwner = useRef(selectionOwner);
  currentSelectionOwner.current = selectionOwner;
  const [selectedSideText, setSelectedSideText] = useState<{ owner: string; text: string; turnId: string; itemId: string; startUtf8?: number; endUtf8?: number } | null>(null);
  useLayoutEffect(() => { setSelectedSideText(null); }, [selectionOwner]);
  const captureSideSelection = () => {
    if (!onSideSelection) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return;
    const range = selected.getRangeAt(0);
    const start = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement)?.closest<HTMLElement>("[data-side-item-id]");
    const end = (range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement)?.closest<HTMLElement>("[data-side-item-id]");
    if (!start || start !== end) return;
    const text = selected.toString();
    if (!text.trim()) return;
    const turnId = start.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId;
    const itemId = start.dataset.sideItemId;
    if (!turnId || !itemId) return;
    const sourceTurn = (thread.turns ?? []).find((turn: Data) => turn.id === turnId);
    const canonical = sourceTurn?.items?.find((item: Data) => item.id === itemId);
    // 流式回复的增量尚未确认持久化；DOM 相等不能证明选区属于冻结证据。
    const streamingReply = sourceTurn?.status === "inProgress" && canonical?.type === "agentMessage";
    const canonicalText = canonical?.type === "agentMessage" ? canonical.text : canonical?.type === "userMessage" && canonical.content?.length === 1 && canonical.content[0].type === "text" ? canonical.content[0].text :
      canonical?.type === "dynamicToolCall" && canonical.success === true && canonical.contentItems?.length === 1 ? canonical.contentItems[0]?.text : undefined;
    const body = canonical?.type === "dynamicToolCall" ? start.querySelector<HTMLElement>("[aria-label='工具结果']") : start.querySelector<HTMLElement>(".conversation-markdown");
    if (!streamingReply && canonicalText && body && body.textContent === canonicalText && body.contains(range.startContainer) && body.contains(range.endContainer)) {
      const prefix = range.cloneRange(); prefix.selectNodeContents(body); prefix.setEnd(range.startContainer, range.startOffset);
      const startUtf8 = new TextEncoder().encode(prefix.toString()).length;
      const endUtf8 = startUtf8 + new TextEncoder().encode(text).length;
      setSelectedSideText({ owner: selectionOwner, text, turnId, itemId, startUtf8, endUtf8 });
    } else setSelectedSideText({ owner: selectionOwner, text, turnId, itemId });
  };
  const askAboutSelection = async () => {
    const chosen = selectedSideText;
    if (!chosen || chosen.owner !== selectionOwner || !onSideSelection) return;
    let selection: Data = { kind: "userQuote", text: chosen.text, claimedTurnId: chosen.turnId, claimedItemId: chosen.itemId };
    if (chosen.startUtf8 !== undefined && chosen.endUtf8 !== undefined) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chosen.text));
      selection = { kind: "itemRange", turnId: chosen.turnId, itemId: chosen.itemId,
        startUtf8: chosen.startUtf8, endUtf8: chosen.endUtf8,
        textSha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
    }
    // 计算摘要期间也可能切换来源；旧回调不能把选区交给新会话。
    if (currentSelectionOwner.current !== chosen.owner) return;
    const turn = (thread.turns ?? []).find((item: Data) => item.id === chosen.turnId);
    onSideSelection(selection, chosen.text, turn?.status === "completed" ? { kind: "turn", turnId: chosen.turnId, boundary: "after" } : undefined);
    setSelectedSideText(null);
  };
  const canFork = !!onFork && project.core?.features?.forkPreview === true
    && !thread.parentThreadId && !thread.desktop?.archived
    && (!thread.conversation || thread.conversation.kind === "fork");
  const unresolved = (turn: Data) => (turn.items ?? []).some((item: Data) => item.type === "dynamicToolCall" && (
    item.status === "inProgress" || item.execution?.outcome === "running"
    || item.execution?.hooks?.some((hook: Data) => hook.outcome === "running")
    || item.execution?.plugin?.operations?.some((op: Data) => op.outcome === "running")
    || !item.execution?.inspection && (item.execution?.outcome === "unknown"
      || item.execution?.hooks?.some((hook: Data) => hook.outcome === "unknown")
      || item.execution?.plugin?.operations?.some((op: Data) => op.outcome === "unknown"))));
  const prefixIssue = (thread.turns ?? []).map((turn: Data) => turn.status === "inProgress" || unresolved(turn) ? turn.id : "");
  const activeOwner = useRef<string | undefined>(undefined);
  const seenTurn = useRef({ owner, id: latestTurnId });
  const reservation = useRef<ResponseSpace | undefined>(readingViews.get(owner)?.responseSpace);
  const [readingHistory, setReadingHistory] = useState(false);
  const rememberReading = () => {
    const element = container.current;
    if (element && activeOwner.current) readingViews.set(activeOwner.current, {
      top: element.scrollTop, following: follow.current,
      atTail: element.scrollHeight - element.scrollTop - element.clientHeight <= 1,
      responseSpace: reservation.current && { ...reservation.current },
    });
  };
  const releaseResponseSpace = () => {
    reservation.current = undefined;
    if (responseSpace.current) responseSpace.current.style.height = "0px";
  };
  const updateReading = () => {
    const element = container.current;
    if (!element) return;
    const space = reservation.current;
    const section = element.querySelector<HTMLElement>("[data-latest-turn=true]");
    const viewport = readingViewport.current;
    // Viewport/font reflow can queue scroll before resize reconciliation,
    // including natural first-turn history with no reserved response space.
    // Its clamped position must not overwrite the existing reading intent.
    if (viewport && (element.clientWidth !== viewport.width || element.clientHeight !== viewport.height)) return;
    // A folded/completed turn can shrink and clamp scrollTop before the queued
    // resize reconciliation. That scroll is layout, not a reader departure.
    // Explicit wheel and bottom actions release the space before reaching here.
    if (space && section && Math.abs(section.getBoundingClientRect().height - space.contentHeight) > 0.5) return;
    const previous = readingViews.get(activeOwner.current ?? owner);
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    // Scrollbar, keyboard and turn navigation can leave the tail without a
    // wheel event. Release only on departure, not on layout-driven growth.
    const departed = !!reservation.current && !!previous && remaining > 1 && element.scrollTop < previous.top - 1;
    if (departed) releaseResponseSpace();
    // Releasing space can clamp this same navigation frame to the new tail.
    // Preserve its departure intent instead of immediately resuming following.
    follow.current = !departed && element.scrollHeight - element.scrollTop - element.clientHeight < 120 &&
      (follow.current || !!previous && element.scrollTop > previous.top + 1);
    rememberReading();
    setReadingHistory(!follow.current && element.scrollHeight - element.scrollTop - element.clientHeight >= 120);
  };
  const returnToBottom = () => {
    releaseResponseSpace();
    follow.current = true;
    // Instant scrolling avoids interpreting smooth-scroll frames as a reader
    // leaving the tail. Reading navigation never submits or restores execution.
    container.current?.scrollTo({ top: container.current.scrollHeight });
    updateReading();
  };
  const renderAgentMessage = (entry: Data, turn: Data, deferActions = false) => !entry.text?.trim() ? null : <div className={`assistant-message${deferActions ? " assistant-message-final" : ""}`} data-message-phase={entry.phase ?? "legacy"} data-side-item-id={entry.id} key={entry.id}>
    <MessageResponse className="conversation-markdown" preserveLineBreaks streaming={turn.status === "inProgress"} theme={dark ? "dark" : "light"} onOpenExternalUrl={onLink} onOpenFileLink={onFile}>{entry.text}</MessageResponse>
    {!deferActions && entry.phase !== "commentary" && turn.status !== "inProgress" && <MessageActions text={entry.text} />}
  </div>;
  useLayoutEffect(() => {
    const element = container.current, spacer = responseSpace.current;
    if (!element || !spacer) return;
    const previous = seenTurn.current;
    const switched = activeOwner.current !== owner;
    const remembered = readingViews.get(owner);
    const latest = thread.turns?.at(-1);
    const section = [...element.querySelectorAll<HTMLElement>("[data-turn-id]")].find(el => el.dataset.turnId === latestTurnId);
    const user = section?.querySelector<HTMLElement>(".user-message");
    // The accepted user starts at the live column inset. Earlier action rows
    // and inter-turn gaps belong to history, not this response track; reserving
    // them exposes the preceding file card after reflow. Long replies still
    // consume this space naturally, and explicit history reading releases it.
    const responseTrackHeight = () => {
      if (!section || !user) return 0;
      const column = getComputedStyle(section.parentElement!);
      return Math.max(0, element.clientHeight - parseFloat(column.paddingTop) - parseFloat(column.paddingBottom));
    };
    if (switched) {
      follow.current = remembered?.following ?? true;
      reservation.current = reserveResponseSpace && remembered?.responseSpace ? { ...remembered.responseSpace } : undefined;
    } else if (previous.id !== latestTurnId) {
      // Reflow may leave all prior history visible while preserving a former
      // departure. The next accepted message follows from that actual tail;
      // readers still above an overflowing history retain their position.
      follow.current ||= remembered?.atTail === true;
      // Only a mounted, accepted user follow-up creates space. Cold history,
      // the first turn and Goal continuations retain natural content height.
      // Core may deliver the user and process together or separately. Reserve
      // from the accepted user boundary, never the first transient process size.
      reservation.current = reserveResponseSpace && previous.id && follow.current && section && user && !goalContinuationLabel(latest)
        ? { turnId: latestTurnId, height: 0, contentHeight: 0 } : undefined;
    }
    // 自然流布局由父容器滚动；自身高度包含占位，
    // 用它计算预留空间会在下一次尺寸变化时形成反馈增长。
    if (!reserveResponseSpace) reservation.current = undefined;
    activeOwner.current = owner;
    seenTurn.current = { owner, id: latestTurnId };
    const layout = () => {
      const space = reservation.current;
      if (space && section && space.turnId === latestTurnId) {
        const contentHeight = section.getBoundingClientRect().height;
        // Recompute from the live track: both response growth and input-area
        // collapse change layout. Neither first-paint size becomes history.
        space.height = Math.max(0, responseTrackHeight() - contentHeight);
        space.contentHeight = contentHeight;
        spacer.style.height = `${space.height}px`;
      } else spacer.style.height = "0px";
      if (follow.current) element.scrollTop = element.scrollHeight;
      readingViewport.current = { width: element.clientWidth, height: element.clientHeight };
      setReadingHistory(!follow.current && element.scrollHeight - element.scrollTop - element.clientHeight >= 120);
      rememberReading();
    };
    layout();
    if (switched && !follow.current) {
      element.scrollTop = remembered?.top ?? 0;
      rememberReading();
    }
    const wheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || element.scrollHeight <= element.clientHeight) return;
      follow.current = false;
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
    element.addEventListener("wheel", wheel, { passive: false });
    // File summaries, disclosures and Markdown/media resize independently of
    // Core snapshots. Reuse this reading owner; no new store or execution loop.
    let frame: number | undefined;
    const resize = new ResizeObserver(() => {
      frame ??= requestAnimationFrame(() => { frame = undefined; layout(); });
    });
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => {
      resize.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      element.removeEventListener("wheel", wheel);
    };
  }, [owner, latestTurnId, reserveResponseSpace]);
  return (
    <div className="messages-shell">
    <TurnNavigation turns={thread.turns ?? []} container={container} onNavigate={() => {
      follow.current = false;
      releaseResponseSpace();
      rememberReading();
    }} />
    <div
      className="messages"
      ref={container}
      onScroll={updateReading}
      onMouseUp={captureSideSelection}

    >
      <div className="message-column">
        {beforeTurns}
        {inherited.loading && <p role="status">正在加载继承历史…</p>}
        {inherited.error && <p role="alert">继承历史读取失败：{inherited.error}</p>}
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
          const beforeReason = earlierIssue ? "较早轮次有未结算操作；请先在来源核查或选择更早边界" : "";
          const afterReason = turn.status === "inProgress" ? "此轮仍在运行；可选择轮次之前" :
            inspectTurn ? "历史包含未结算或未核查的操作；请在来源核查或选择更早边界" : "";
          const forkAt = (boundary: "before" | "after", anchor?: HTMLElement) => {
            setForking(true); setForkError(null);
            void onFork?.(turn.id, boundary, anchor).catch((cause: Error & { data?: { reason?: string } }) => {
              const reason = cause.data?.reason;
              const message = reason === "TURN_NOT_TERMINAL" ? "此轮仍在运行；请选择之前边界或等待完成后刷新。"
                : reason === "HISTORY_UNRESOLVED" ? "来源历史有未结算或未核查的操作；请在来源核查 UNKNOWN，或选择更早边界。"
                : reason === "ANCHOR_NOT_FOUND" ? "轮次位置已变化；请刷新来源后重新选择。" : cause.message;
              setForkError({ turnId: turn.id, message });
            }).finally(() => setForking(false));
          };
          const forkControls = canFork ? <><button type="button" className="turn-fork-trigger" aria-label="从此轮创建聊天分支" title={afterReason || "从这里创建聊天分支"} disabled={forking || !!afterReason} onClick={event => forkAt("after", event.currentTarget)}><ForkIcon /><span>分支</span></button><DropdownMenu>
              <DropdownMenuTrigger render={<button type="button" className="icon-button" disabled={forking} aria-label={`轮次操作 ${turnIndex + 1}`}><MoreOptionsIcon /></button>} />
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!!afterReason} title={afterReason || undefined} onClick={() => forkAt("after")}>在此轮之后分支</DropdownMenuItem>
                {afterReason && <p className="px-2 text-xs text-muted-foreground">{afterReason}</p>}
                <DropdownMenuItem disabled={!!beforeReason} title={beforeReason || undefined} onClick={() => forkAt("before")}>在此轮之前分支</DropdownMenuItem>
                {beforeReason && <p className="px-2 text-xs text-muted-foreground">{beforeReason}</p>}
                {inspectTurn && <DropdownMenuItem onClick={() => document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(inspectTurn)}"]`)?.scrollIntoView({ block: "center" })}>查看来源轮次的核查入口</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu></> : null;
          const segments = executionSegments(turn.items ?? [], turn.status);
          const hasFinal = segments.some((item: Data) => item.type === "agentMessage" && item.phase === "final_answer" && item.text?.trim());
          const finalMessage = segments.findLast((item: Data) => item.type === "agentMessage" && item.phase === "final_answer" && item.text?.trim());
          // Old snapshots have no phases. A completed text-tail allows a purely
          // chronological disclosure; it does not classify or rewrite any message.
          // Unsettled work, pending input and terminal exceptions stay inspectable.
          const tail = segments.at(-1);
          const legacyReply = turn.status === "completed" && tail?.type === "agentMessage" &&
            segments.every((item: Data) => item.type !== "agentMessage" || item.phase == null) &&
            !executionOutcome(segments.flatMap((item: Data) => item.items ?? [])).unfinished &&
            !project.state?.interactions?.[thread.id]?.data?.some((item: Data) => item.status === "pending" && item.turnId === turn.id) ? tail : undefined;
          const responseMessage = finalMessage ?? legacyReply;
          const hasReadingSummary = hasFinal || !!legacyReply;
          // User follow-ups, media and the retained reply remain in original order.
          const groups: { id: string; progress: boolean; entries: { item: Data; index: number }[] }[] = [];
          segments.forEach((item: Data, index: number) => {
            const progress = item.type !== "questionAnswer" && item.type !== "userMessage" && item.type !== "agentMedia" && (item.type !== "agentMessage" || item.phase === "commentary" || (!!legacyReply && item.id !== legacyReply.id));
            const previous = groups.at(-1);
            if (progress && previous?.progress) previous.entries.push({ item, index });
            else groups.push({ id: item.id, progress, entries: [{ item, index }] });
          });
          // Stop is a Core terminal state, not a completed response. Keep its
          // process text inspectable and put the state before that content.
          const stopHeaderIndex = groups.findIndex(group => group.entries.some(({ item }) => item.type !== "userMessage"));
          const firstProgress = groups.findIndex(group => group.progress);
          const initialUser = segments.find(item => item.type === "userMessage");
          const queue = project.state?.queues?.[thread.id];
          const stopAccepted = turn.status === "inProgress" && queue?.paused === true && queue?.pauseReason === "stopped";
          const command = (turn.items ?? []).find((item: Data) => item.type === "dynamicToolCall" && item.tool === "run_command");
          const resourceLabel = command && queue?.pauseReason === "stopped" ? commandResourceLabel(command) : null;
          const stopHeading = <div className="turn-stop-heading turn-progress-heading">
            <div className="turn-progress-label"><span className="turn-status turn-progress-summary" role="status">已停止{turn.error ? `：${turnFailureMessage(turn)}` : ""}</span></div>
            <div className="turn-progress-divider" />
          </div>;
          return <section key={turn.id} data-turn-id={turn.id} data-turn-status={turn.status} data-latest-turn={turn.id === latestTurnId}>
            {stopAccepted && <p role="status">停止已受理，等待执行结算</p>}
            {resourceLabel && <p role="status">{resourceLabel}</p>}
            {groups.map((group, groupIndex) => {
            const outcome = executionOutcome(group.entries.flatMap(({ item }) => item.items ?? []));
            const contents = group.entries.map(({ item, index }) => {
              if (item.type === "questionAnswer") return <div className="user-message" data-question-answer={item.id} key={item.id}>
                <div className="user-message-content"><div className="user-bubble question-answer-bubble">
                  {item.questions.map((question: Data) => <div key={question.id}>
                    <p className="question-answer-title">{question.title}</p>
                    <p>{item.answers[question.id]}</p>
                  </div>)}
                </div></div>
              </div>;
              if (item.type === "userMessage") {
                const continuation = goalContinuationLabel(turn);
                if (continuation && item.id === turn.items?.find((entry: Data) => entry.type === "userMessage")?.id) {
                  return <div className="turn-status" key={item.id}>{continuation}</div>;
                }
                const content = item.content ?? [];
                const text = content.filter((part: Data) => part.type === "text").map((part: Data) => part.text ?? "").join("\n");
                const feedback = sentReviewFeedback(text);
                const attachments = content.filter((part: Data) => part.type !== "text");
                const browserFeedback = sentBrowserAnnotations(feedback.text, attachments);
                const ordinaryAttachments = attachments.filter((part: Data) => !browserFeedback.notes.some(note => note.imageUri === (part.url ?? part.uri)));
                return (
                  <div className="user-message" data-side-item-id={item.id} key={item.id}>
                    <div className="user-message-content">
                      <SentReviewComments comments={feedback.comments} />
                      <SentBrowserAnnotations notes={browserFeedback.notes} attachments={attachments} projectId={project.id} threadId={thread.id} action={action} />
                      {ordinaryAttachments.length > 0 ? <div className="user-attachments" data-testid="user-attachments">
                        {ordinaryAttachments.map((part: Data, i: number) => <SentAttachment key={part.url ?? part.uri ?? i}
                          part={part} projectId={project.id} threadId={thread.id} action={action} />)}
                      </div> : null}
                      {browserFeedback.text.trim() ? <div className="user-bubble">
                        <MessageResponse className="conversation-markdown user-message-body" preserveLineBreaks theme={dark ? "dark" : "light"} onOpenExternalUrl={onLink} onOpenFileLink={onFile}>{browserFeedback.text}</MessageResponse>
                      </div> : null}
                      {text.trim() && <MessageActions text={text} />}
                    </div>
                  </div>
                );
              }
              if (item.type === "agentMessage") return renderAgentMessage(item, turn, item.id === finalMessage?.id);
              if (item.type === "agentMedia") return <div className="assistant-media flex flex-wrap gap-2" key={item.id}>
                <SentAttachment part={{ type: item.modality, uri: item.media.uri,
                  name: item.modality === "image" ? "生成的图片" : item.modality === "audio" ? "生成的音频" : "生成的文件" }}
                  projectId={project.id} threadId={thread.id} action={action} />
              </div>;
              return <TurnExecution key={item.id} active={index === segments.length - 1} items={item.items} turn={turn} project={project} threadId={thread.id}
                hasTurnSummary={group.progress && turn.status === "completed" && hasReadingSummary}
                renderItem={(entry: Data, disclosure) => {
                  if (entry.type === "dynamicToolCall") return <div data-side-item-id={entry.id} key={entry.id}><ToolEvent item={entry} {...disclosure} onFile={onFile} onAgent={isInherited ? undefined : onAgent} turnId={turn.id} action={action} projectId={project.id} threadId={thread.id} readTurnReview={turn.status === "completed" ? readTurnReview : undefined} /></div>;
                  if (entry.type === "modelContext") return null;
                  return <details className="tool-call" key={entry.id}><summary>{entry.type}</summary><pre>{JSON.stringify(entry, null, 2)}</pre></details>;
                }} />;
            });
            return <Fragment key={group.id}>
              {turn.status === "interrupted" && groupIndex === stopHeaderIndex && stopHeading}
              {group.progress ? <TurnProgress summaryAvailable={turn.status === "completed" && hasReadingSummary}
                label={(groupIndex === firstProgress ? completedTimeLabel(turn) : undefined) ?? (legacyReply ? "早前消息与活动" : "本轮过程")}
                settled={turn.status === "completed" && hasReadingSummary && !outcome.unfinished}
                {...outcome}>{contents}</TurnProgress> : contents}
              {group.entries.some(({ item }) => item === initialUser) &&
                (turn.status !== "completed" || firstProgress < 0 || !hasReadingSummary) &&
                <TurnElapsed turn={turn} connected={!!project.state?.connected} />}
            </Fragment>;
            })}
            {!isInherited && (turn.items ?? []).filter((item: Data) => item.type === "dynamicToolCall").map((item: Data) =>
              <UnknownToolInspection key={`${project.id}:${thread.id}:${item.id}`} item={item} project={project} thread={thread} action={action} />)}
            <TurnFileSummary turn={turn} readTurnReview={readTurnReview} onFile={onFile} onReview={onReview} />
            {responseMessage && turn.status !== "inProgress" && <MessageActions text={responseMessage.text}><TurnHookStats turn={turn} />{forkControls}{responseActions?.(responseMessage)}</MessageActions>}
            {canFork && forkError?.turnId === turn.id && <p role="alert" className="notice">{forkError?.message}</p>}
            {turn.status === "inProgress" && (!segments.length || ["userMessage", "agentMessage", "agentMedia"].includes(segments.at(-1)?.type)) && (
              <TurnExecution items={[]} turn={turn} project={project} threadId={thread.id} renderItem={() => null} />
            )}
            {turn.status === "interrupted" && stopHeaderIndex < 0 && stopHeading}
            {turn.status !== "inProgress" && turn.status !== "interrupted" && !(turn.status === "completed" && hasReadingSummary) && (
              <div className="turn-status">
                {({ completed: "已完成", interrupted: "已停止", failed: "执行失败" } as Data)[
                  turn.status
                ] ?? turn.status}
                {turn.error
                  ? `：${turnFailureMessage(turn)}`
                  : ""}
              </div>
            )}
            {!finalMessage && turn.status !== "inProgress" && turn.items?.some((item: Data) => item.type === "dynamicToolCall" && item.execution?.hooks?.length) &&
              <div className="message-actions"><TurnHookStats turn={turn} /></div>}
          </section>;
        })}
        <div ref={responseSpace} className="message-response-space" aria-hidden="true" />
      </div>
    </div>
    {selectedSideText?.owner === selectionOwner && <button type="button" className="side-selection-action" onClick={() => void askAboutSelection()}>在旁路中询问所选内容</button>}
    {readingHistory && <TimelineBottomButton onClick={returnToBottom} />}
    </div>
  );
}
