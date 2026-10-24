import type { ConversationSelectionReference, ConversationSelectionContentType } from "./conversationSelectionReference.js";
import { projectConversationContent, conversationContentToText } from "./conversationContent.js";
import { ConversationContentView } from "./ConversationContentView.js";
import { GenUiCard } from "./GenUiWorkspace.js";
import { submitMessage, sending, markSending } from "./Composer.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { WorktreeStatus } from "./WorktreeStatus.js";
import { TurnUsage } from "./TurnUsage.js";
import { mcpResultKey, type McpResultSource, type McpResultState } from "./mcp-app-services.js";
import { McpContentLabel } from "./McpComposerAttachments.js";
import { useForkHistory } from "./ForkHistory.js";
import { DeferredHistoryItem, useConversationHistory } from "./ConversationHistory.js";
import { UnknownToolInspection } from "./UnknownToolInspection.js";
import { TurnNavigation } from "./TurnNavigation.js";
import { toolPresentation, executionOutcome, executionSegments, goalContinuationLabel, turnFailureMessage } from "./conversationPresentation.js";
import { TurnProgress } from "./TurnProgress.js";
import { TurnElapsed } from "./TurnElapsed.js";
import { ForkIcon } from "./interfaceIcons.js";
import { UserPromptEdit } from "./UserPromptEdit.js";
import { UserMessageBody } from "./UserMessageBody.js";
import { isOrdinaryConversation, interruptionLabel } from "./ordinaryConversation.js";
import { MessageActions } from "./MessageActions.js";
import { CollapsibleText } from "./CollapsibleText.js";
import { UserFeedback } from "./UserFeedback.js";
import { TurnHookStats } from "./TurnHookStats.js";
import { ToolEvent } from "./ToolEvent.js";
import { TurnActivity, TurnExecution } from "./TurnExecution.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { TimelineBottomButton } from "./TimelineBottomButton.js";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent } from "./components/ui/popover.js";
import { MessageResponse } from "./components/ai-elements/message.js";
import { SentAttachment } from "./MessageAttachment.js";
import { sentReviewFeedback } from "./reviewComments.js";
import { SentBrowserAnnotations } from "./BrowserAnnotationAttachments.js";
import { sentImageAnnotations } from "./imageAnnotations.js";
import { ImageAnnotationList } from "./ImageAnnotationViews.js";
import { sentBrowserAnnotations } from "./browserAnnotations.js";
import { SentReviewComments } from "./ReviewCommentViews.js";
import { ScheduledTaskCards } from "./ScheduledTasks.js";
import { TurnFileSummary } from "./TurnFileSummary.js";
import type { Data, Action } from "./services.js";
type TranscriptSelectionSnapshot = {
  owner: string; text: string; turnId: string; itemId: string; contentType: ConversationSelectionContentType; range: Range; rect: DOMRect;
  provenance: { kind: "userQuote" } | { kind: "itemRange"; startUtf8: number; endUtf8: number };
};
type ResponseSpace = { turnId: string; height: number; contentHeight: number };
type ReadingAnchor = { turnId: string; itemId: string; blockIndex: number | null; offset: number };
type ReadingView = { top: number; following: boolean; atTail: boolean; responseSpace?: ResponseSpace; anchor?: ReadingAnchor };
type ReadingCheckpoint = { owner: string; position: { kind: "latest" } | { kind: "reading"; anchor: ReadingAnchor } };
const readingCheckpointKey = "areal-gui:reading-views:v1";
const readingCheckpointLimit = 64 * 1024;
const readingViews = new Map<string, ReadingView>();
let readingViewsHydrated = false;
let savedReadingCheckpoint: string | null = null;
function checkpointRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function checkpointId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
function hydrateReadingViews() {
  if (readingViewsHydrated) return;
  readingViewsHydrated = true;
  try {
    const raw = window.sessionStorage.getItem(readingCheckpointKey);
    if (!raw || raw.length > readingCheckpointLimit) return;
    const checkpoint: unknown = JSON.parse(raw);
    if (!checkpointRecord(checkpoint) || checkpoint.version !== 1 || !Array.isArray(checkpoint.views) || checkpoint.views.length > 32) return;
    for (const entry of [...checkpoint.views].reverse()) {
      if (!checkpointRecord(entry) || typeof entry.owner !== "string" || entry.owner.length > 4096 || !checkpointRecord(entry.position)) continue;
      const identity: unknown = JSON.parse(entry.owner);
      if (!Array.isArray(identity) || identity.length !== 3 || !checkpointId(identity[0]) || !checkpointId(identity[1]) || identity[2] !== false) continue;
      const owner = JSON.stringify(identity);
      const position = entry.position;
      if (position.kind === "latest") readingViews.set(owner, { top: 0, following: true, atTail: true });
      else if (position.kind === "reading" && checkpointRecord(position.anchor)) {
        const { turnId, itemId, blockIndex, offset } = position.anchor;
        if (!checkpointId(turnId) || !checkpointId(itemId) || typeof offset !== "number" || !Number.isFinite(offset) || Math.abs(offset) > 1_000_000 ||
          blockIndex !== null && (typeof blockIndex !== "number" || !Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex > 1_000_000)) continue;
        readingViews.set(owner, { top: 0, following: false, atTail: false, anchor: { turnId, itemId, blockIndex, offset } });
      }
    }
    savedReadingCheckpoint = raw;
  } catch {}
}
function saveReadingViews() {
  try {
    const views: ReadingCheckpoint[] = [];
    for (const [owner, view] of [...readingViews].reverse()) {
      const position: ReadingCheckpoint["position"] | undefined = view.following ? { kind: "latest" } : view.anchor && { kind: "reading", anchor: view.anchor };
      if (!position) continue;
      const entry = { owner, position };
      if (JSON.stringify({ version: 1, views: [...views, entry] }).length > readingCheckpointLimit) continue;
      views.push(entry);
      if (views.length === 32) break;
    }
    const serialized = JSON.stringify({ version: 1, views });
    if (serialized === savedReadingCheckpoint) return;
    window.sessionStorage.setItem(readingCheckpointKey, serialized);
    savedReadingCheckpoint = serialized;
  } catch {}
}
function readingBlocks(item: HTMLElement) {
  return [...(item.querySelector<HTMLElement>(".conversation-markdown")?.children ?? [])].filter((element): element is HTMLElement => element instanceof HTMLElement);
}
function readingAnchor(element: HTMLElement): ReadingAnchor | undefined {
  const viewport = element.getBoundingClientRect();
  for (const item of element.querySelectorAll<HTMLElement>("[data-side-item-id]")) {
    const turnId = item.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId;
    if (!turnId || !item.dataset.sideItemId) continue;
    const blocks = readingBlocks(item);
    const blockIndex = blocks.findIndex(block => block.getBoundingClientRect().bottom > viewport.top && block.getBoundingClientRect().top < viewport.bottom);
    const block = blocks[blockIndex] ?? item;
    const box = block.getBoundingClientRect();
    if (box.bottom > viewport.top && box.top < viewport.bottom) return { turnId, itemId: item.dataset.sideItemId, blockIndex: blockIndex < 0 ? null : blockIndex, offset: box.top - viewport.top };
  }
}
function restoreReadingAnchor(element: HTMLElement, anchor: ReadingAnchor) {
  const turn = [...element.querySelectorAll<HTMLElement>("[data-turn-id]")].find(turn => turn.dataset.turnId === anchor.turnId);
  const item = [...(turn?.querySelectorAll<HTMLElement>("[data-side-item-id]") ?? [])].find(item => item.dataset.sideItemId === anchor.itemId);
  const block = item && (anchor.blockIndex === null ? item : readingBlocks(item)[anchor.blockIndex]);
  if (!block) return false;
  const box = block.getBoundingClientRect();
  if (box.height <= 0 || element.clientHeight <= 0) return false;
  const offset = Math.max(1 - box.height, anchor.offset);
  element.scrollTop += box.top - element.getBoundingClientRect().top - offset;
  return Math.abs(block.getBoundingClientRect().top - element.getBoundingClientRect().top - offset) <= 1;
}
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
  onAddSelection,
  responseActions,
  embedded = false,
  readOnly = false,
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
  readOnly?: boolean;
  afterTurns?: ReactNode;
  reserveResponseSpace?: boolean;
  beforeTurns?: ReactNode;
  onAgent?: (id: string) => void;
  onFork?: (turnId: string, anchor?: HTMLElement) => Promise<void>;
  responseActions?: (message: Data) => ReactNode;
  onSideSelection?: (selection: Data, text: string, anchor?: Data, reference?: ConversationSelectionReference) => void;
  onAddSelection?: (reference: ConversationSelectionReference) => void;
  project: Data;
  thread: Data;
  action: Action;
  dark: boolean;
  onLink: (url: string) => void;
  onFile: (path: string) => void;
  onReview: (turnId: string) => void;
  readTurnReview: (turnId: string, itemId?: string) => Promise<Data>;
}) {
  const { t } = useI18n();
  hydrateReadingViews();
  const inherited = useForkHistory(project.id, localThread, action);
  const history = useConversationHistory(project.id, localThread, action);
  const thread: Data = { ...localThread, turns: [...inherited.turns, ...(localThread.turns ?? [])] };
  const inheritedIds = new Set(inherited.turns.map(turn => turn.id));
  const creationAnchor = localThread.displayHistory?.complete === false ? undefined : localThread.turns?.[0]?.id;
  const ordinary = isOrdinaryConversation(localThread, project.configurations?.[localThread.id]);
  const editable = ordinary && !readOnly ? (localThread.turns ?? []).flatMap((turn: Data) => turn.continuedFromTurnId || goalContinuationLabel(turn) ? [] : (turn.items ?? []).filter((item: Data) => item.type === "userMessage")).at(-1)?.id : undefined;
  const responseSpace = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pendingReading = useRef<ReadingAnchor | undefined>(undefined);
  const disclosureReading = useRef<{ control: HTMLElement; offset: number } | undefined>(undefined);
  const readingViewport = useRef<{ width: number; height: number } | undefined>(undefined);
  const owner = JSON.stringify([project.id, thread.id, embedded]);
  const latestTurnId = thread.turns?.at(-1)?.id;
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<{ turnId: string; message: string } | null>(null);
  const selectionOwner = JSON.stringify([project.core?.instanceId, project.core?.connectionGeneration, project.id, thread.id]);
  const currentSelectionOwner = useRef(selectionOwner);
  currentSelectionOwner.current = selectionOwner;
  const [selectedSideText, updateSelection] = useState<TranscriptSelectionSnapshot | null>(null);
  const selectionSnapshot = useRef<TranscriptSelectionSnapshot | null>(null);
  const setSelectedSideText = (next: TranscriptSelectionSnapshot | null) => { selectionSnapshot.current = next; updateSelection(next); };
  useLayoutEffect(() => { setSelectedSideText(null); }, [selectionOwner, !!onAddSelection, !!onSideSelection, readOnly]);
  const selectionIsCurrent = (chosen: TranscriptSelectionSnapshot) => {
    const selected = window.getSelection();
    return currentSelectionOwner.current === chosen.owner && selectionSnapshot.current === chosen
      && chosen.range.startContainer.isConnected && chosen.range.endContainer.isConnected
      && !!container.current?.contains(chosen.range.commonAncestorContainer)
      && selected?.rangeCount === 1 && !selected.isCollapsed && selected.toString() === chosen.text
      && selected.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, chosen.range) === 0
      && selected.getRangeAt(0).compareBoundaryPoints(Range.END_TO_END, chosen.range) === 0
      && chosen.range.toString() === chosen.text;
  };
  useEffect(() => {
    const invalidate = () => { const chosen = selectionSnapshot.current; if (chosen && !selectionIsCurrent(chosen)) setSelectedSideText(null); };
    const dismiss = () => setSelectedSideText(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !selectionSnapshot.current) return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener("selectionchange", invalidate);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("selectionchange", invalidate);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  });
  const captureSideSelection = () => {
    setSelectedSideText(null);
    if ((!onSideSelection && !onAddSelection) || readOnly) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return;
    const range = selected.getRangeAt(0);
    const start = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement)?.closest<HTMLElement>("[data-side-item-id]");
    const end = (range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement)?.closest<HTMLElement>("[data-side-item-id]");
    if (!start || start !== end || !container.current?.contains(start)
      || !container.current.contains(range.commonAncestorContainer)) return;
    const selectedElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    if (selectedElement?.closest("button, input, textarea, [contenteditable='true']")) return;
    const text = selected.toString();
    if (!text.trim()) return;
    const turnId = start.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId;
    const itemId = start.dataset.sideItemId;
    if (!turnId || !itemId) return;
    const sourceTurn = (thread.turns ?? []).find((turn: Data) => turn.id === turnId);
    const canonical = sourceTurn?.items?.find((item: Data) => item.id === itemId);
    if (!canonical) return;
    const contentType: ConversationSelectionContentType = canonical.type === "userMessage" ? "user" : canonical.type === "agentMessage" ? "assistant" : canonical.type === "reasoning" ? "reasoning" : "tool";
    const snapshot = { owner: selectionOwner, text, turnId, itemId, contentType, range: range.cloneRange(), rect: range.getBoundingClientRect() };
    // 流式回复的增量尚未确认持久化；DOM 相等不能证明选区属于冻结证据。
    const streamingReply = sourceTurn?.status === "inProgress" && canonical?.type === "agentMessage";
    const canonicalText = canonical?.type === "agentMessage" ? canonical.text : canonical?.type === "userMessage" && canonical.content?.length === 1 && canonical.content[0].type === "text" ? canonical.content[0].text :
      canonical?.type === "dynamicToolCall" && canonical.success === true && canonical.contentItems?.length === 1 ? canonical.contentItems[0]?.text : undefined;
    const body = canonical?.type === "dynamicToolCall" ? start.querySelector<HTMLElement>("[aria-label='工具结果']") : start.querySelector<HTMLElement>(".conversation-markdown");
    if (!streamingReply && canonicalText && body && body.textContent === canonicalText && body.contains(range.startContainer) && body.contains(range.endContainer)) {
      const prefix = range.cloneRange(); prefix.selectNodeContents(body); prefix.setEnd(range.startContainer, range.startOffset);
      const startUtf8 = new TextEncoder().encode(prefix.toString()).length;
      const endUtf8 = startUtf8 + new TextEncoder().encode(text).length;
      setSelectedSideText({ ...snapshot, provenance: { kind: "itemRange", startUtf8, endUtf8 } });
    } else setSelectedSideText({ ...snapshot, provenance: { kind: "userQuote" } });
  };
  const referenceFor = (chosen: TranscriptSelectionSnapshot): ConversationSelectionReference => ({
    id: crypto.randomUUID(), sourceSessionId: thread.id, sourceRowId: `${chosen.turnId}:${chosen.itemId}`, contentType: chosen.contentType, text: chosen.text,
  });
  const askAboutSelection = async () => {
    const chosen = selectedSideText;
    if (!chosen || !selectionIsCurrent(chosen) || !onSideSelection) return;
    let selection: Data = { kind: "userQuote", text: chosen.text, claimedTurnId: chosen.turnId, claimedItemId: chosen.itemId };
    if (chosen.provenance.kind === "itemRange") {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chosen.text));
      selection = { kind: "itemRange", turnId: chosen.turnId, itemId: chosen.itemId,
        startUtf8: chosen.provenance.startUtf8, endUtf8: chosen.provenance.endUtf8,
        textSha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
    }
    // 计算摘要期间也可能切换来源；旧回调不能把选区交给新会话。
    if (!selectionIsCurrent(chosen)) return;
    const turn = (thread.turns ?? []).find((item: Data) => item.id === chosen.turnId);
    onSideSelection(selection, chosen.text, turn?.status === "completed" ? { kind: "turn", turnId: chosen.turnId, boundary: "after" } : undefined, referenceFor(chosen));
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
    if (!element || !activeOwner.current || pendingReading.current) return;
    readingViews.delete(activeOwner.current);
    readingViews.set(activeOwner.current, {
      top: element.scrollTop, following: follow.current,
      atTail: element.scrollHeight - element.scrollTop - element.clientHeight <= 1,
      responseSpace: reservation.current && { ...reservation.current },
      anchor: follow.current ? undefined : readingAnchor(element),
    });
    saveReadingViews();
  };
  const releaseResponseSpace = () => {
    reservation.current = undefined;
    if (responseSpace.current) responseSpace.current.style.height = "0px";
  };
  const readHere = (control?: HTMLElement) => {
    pendingReading.current = undefined;
    disclosureReading.current = control && container.current
      ? { control, offset: control.getBoundingClientRect().top - container.current.getBoundingClientRect().top }
      : undefined;
    follow.current = false;
    rememberReading();
  };
  const updateReading = () => {
    const element = container.current;
    if (!element || pendingReading.current) return;
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
    follow.current = !disclosureReading.current && !departed && element.scrollHeight - element.scrollTop - element.clientHeight < 120 &&
      (follow.current || !!previous && element.scrollTop > previous.top + 1);
    rememberReading();
    setReadingHistory(!follow.current && element.scrollHeight - element.scrollTop - element.clientHeight >= 120);
  };
  const returnToBottom = () => {
    pendingReading.current = undefined;
    disclosureReading.current = undefined;
    releaseResponseSpace();
    follow.current = true;
    // Instant scrolling avoids interpreting smooth-scroll frames as a reader
    // leaving the tail. Reading navigation never submits or restores execution.
    container.current?.scrollTo({ top: container.current.scrollHeight });
    rememberReading();
    setReadingHistory(false);
    updateReading();
  };
  const renderImage = useCallback((uri: string, name: string) => /^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(uri)
    ? <SentAttachment part={{ type: "image", uri, name: name || "回复图片" }} projectId={project.id} threadId={thread.id} action={action} /> : null, [project.id, thread.id, action]);
  const sendGenUi = async (prompt: string) => {
    if (readOnly || !project.state?.connected || localThread.desktop?.archived) throw Error("Conversation unavailable");
    if (onGenUiFollowUp) return onGenUiFollowUp(prompt);
    if (localThread.conversation?.kind === "side" && localThread.conversation.policy?.kind !== "sideExecutableV2") throw Error("Side submission unavailable");
    const key = `areal-gui:draft:${project.id}:${localThread.id}`;
    if (sending.has(key) || project.pending?.some((entry: Data) => entry.params?.threadId === localThread.id)) throw Error("Submission needs confirmation");
    markSending(key, true);
    try { await submitMessage(action, project.id, localThread.id, prompt, [], { appMessage: true, enqueue: !!localThread.turns?.some((turn: Data) => turn.status === "inProgress") }); }
    finally { markSending(key, false); }
  };
  const renderAgentMessage = (entry: Data, turn: Data, deferActions = false) => {
    if (!entry.text?.trim()) return null;
    const blocks = projectConversationContent(entry.text, turn.status === "completed", turn.status === "inProgress");
    return <div className={`assistant-message${deferActions ? " assistant-message-final" : ""}`} data-message-phase={entry.phase ?? "legacy"} data-side-item-id={entry.id} key={entry.id}>
      <ConversationContentView blocks={blocks} markdown={text => <MessageResponse className="conversation-markdown" preserveLineBreaks streaming={turn.status === "inProgress" && (entry.phase !== "commentary" || entry.id === turn.items?.findLast((item: Data) => ["agentMessage", "dynamicToolCall", "userMessage", "agentMedia"].includes(item.type))?.id)} theme={dark ? "dark" : "light"} onOpenExternalUrl={onLink} onOpenFileLink={onFile} onRenderImage={renderImage} webPreviews>{text}</MessageResponse>} interactive={part => !inheritedIds.has(turn.id) ? <GenUiCard key={`${entry.id}:${part.offset}`} source={{ projectId: project.id, threadId: localThread.id, turnId: turn.id, itemId: entry.id, referenceOffset: part.offset }} title={part.reference.title ?? t("genUi.title")} dark={dark} send={readOnly || localThread.desktop?.archived || !project.state?.connected ? undefined : sendGenUi} /> : <p role="status">{t("genUi.unavailable")}</p>} />
      {!deferActions && entry.phase !== "commentary" && turn.status !== "inProgress" && <MessageActions text={conversationContentToText(blocks)} />}
    </div>;
  };
  useLayoutEffect(() => {
    const element = container.current, spacer = responseSpace.current;
    if (embedded || !element || !spacer) return;
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
    if (switched || previous.id !== latestTurnId) disclosureReading.current = undefined;
    if (switched) {
      follow.current = remembered?.following ?? true;
      pendingReading.current = follow.current ? undefined : remembered?.anchor;
      reservation.current = reserveResponseSpace && remembered?.responseSpace ? { ...remembered.responseSpace } : undefined;
    } else if (previous.id !== latestTurnId) {
      // Reflow may leave all prior history visible while preserving a former
      // departure. The next accepted message follows from that actual tail;
      // readers still above an overflowing history retain their position.
      if (!pendingReading.current) follow.current ||= remembered?.atTail === true;
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
      const disclosure = disclosureReading.current;
      if (disclosure && element.contains(disclosure.control)) {
        element.scrollTop += disclosure.control.getBoundingClientRect().top - element.getBoundingClientRect().top - disclosure.offset;
      } else if (follow.current) element.scrollTop = element.scrollHeight;
      else if (pendingReading.current && restoreReadingAnchor(element, pendingReading.current)) pendingReading.current = undefined;
      readingViewport.current = { width: element.clientWidth, height: element.clientHeight };
      setReadingHistory(!follow.current && element.scrollHeight - element.scrollTop - element.clientHeight >= 120);
      rememberReading();
    };
    if (switched && !follow.current) element.scrollTop = remembered?.top ?? 0;
    layout();
    const cancelPendingReading = () => {
      pendingReading.current = undefined;
      disclosureReading.current = undefined;
      rememberReading();
    };
    const wheel = (event: WheelEvent) => {
      cancelPendingReading();
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
    element.addEventListener("pointerdown", cancelPendingReading);
    element.addEventListener("keydown", cancelPendingReading);
    // File summaries, disclosures and Markdown/media resize independently of
    // Core snapshots. Reuse this reading owner; no new store or execution loop.
    // Resize notifications run before paint; a new frame exposes the old tail.
    const resize = new ResizeObserver(layout);
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => {
      resize.disconnect();
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", cancelPendingReading);
      element.removeEventListener("keydown", cancelPendingReading);
    };
  }, [owner, latestTurnId, reserveResponseSpace]);
  useLayoutEffect(() => {
    const element = container.current;
    if (embedded || !element || activeOwner.current !== owner || !pendingReading.current) return;
    if (restoreReadingAnchor(element, pendingReading.current)) {
      pendingReading.current = undefined;
      rememberReading();
    }
    setReadingHistory(element.scrollHeight - element.scrollTop - element.clientHeight >= 120);
  });
  return (
    <div className={embedded ? "messages-embedded" : "messages-shell"}>
    {!embedded && <TurnNavigation key={owner} turns={thread.turns ?? []} container={container} onNavigate={() => {
      pendingReading.current = undefined;
      disclosureReading.current = undefined;
      follow.current = false;
      releaseResponseSpace();
      rememberReading();
    }} />}
    <div
      className={embedded ? "messages-embedded-content" : "messages"}
      ref={container}
      onScroll={embedded ? undefined : updateReading}
      onMouseUp={captureSideSelection}
      onKeyUp={event => { if (event.key !== "Escape" && event.key !== "Tab" && event.key !== "Enter") captureSideSelection(); }}
      onClickCapture={event => {
        const control = event.target instanceof Element ? event.target.closest<HTMLElement>("button[aria-expanded], summary") : null;
        if (control && event.currentTarget.contains(control) && control.closest(".turn-progress, .turn-execution")) readHere(control);
      }}
    >
      <div className={embedded ? "message-column message-embedded-column" : "message-column"}>
        {localThread.displayHistory?.complete !== false && !(localThread.turns ?? []).some((turn: Data) => (turn.items ?? []).some((item: Data) => item.type === "userMessage")) && <WorktreeStatus events={localThread.worktreeEvents} current={localThread.worktree} />}
        {beforeTurns}
        {inherited.loading && <p role="status">正在加载继承历史…</p>}
        {inherited.error && <p role="alert">继承历史读取失败：{inherited.error}</p>}
        {localThread.displayHistory?.loadingLatest && <p role="status">{t("chat.history.loadingLatest")}</p>}
        {localThread.displayHistory?.supported && localThread.displayHistory.latestTurnComplete !== false && !localThread.displayHistory.complete && <Button type="button" variant="ghost" size="sm"
          disabled={localThread.displayHistory.loadingOlder} onClick={() => { readHere(); void history.load(); }}>
          {localThread.displayHistory.loadingOlder ? t("chat.history.loadingOlder") : t("chat.history.loadOlder")}
        </Button>}
        {history.failure && !history.failure.itemId && <div>
          <p role="alert">{history.failure.message}</p>
          {localThread.displayHistory?.latestTurnComplete === false && <Button type="button" variant="ghost" size="sm"
            disabled={localThread.displayHistory.loadingLatest} onClick={() => void history.load()}>{t("recovery.retryView")}</Button>}
        </div>}
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
          const forkReason = inspectTurn ? "历史包含未结算或未核查的操作；请在来源核查或选择更早轮次" : "";
          const forkAt = (anchor: HTMLElement) => {
            setForking(true); setForkError(null);
            void onFork?.(turn.id, anchor).catch((cause: Error & { data?: { reason?: string } }) => {
              const reason = cause.data?.reason;
              const message = reason === "TURN_NOT_TERMINAL" ? "此轮仍在运行；请等待完成后重新分支。"
                : reason === "HISTORY_UNRESOLVED" ? "来源历史有未结算或未核查的操作；请在来源核查 UNKNOWN，或选择更早轮次。"
                : reason === "ANCHOR_NOT_FOUND" ? "轮次位置已变化；请刷新来源后重新选择。" : cause.message;
              setForkError({ turnId: turn.id, message });
            }).finally(() => setForking(false));
          };
          const forkControls = <>
            {canFork && turn.status !== "inProgress" && <button type="button" className="turn-fork-trigger"
              disabled={forking || !!forkReason} title={forkReason || undefined}
              aria-label="从此轮创建聊天分支" aria-describedby={forkReason ? `fork-reason-${turn.id}` : undefined}
              onClick={event => forkAt(event.currentTarget)}><ForkIcon /><span>分支</span></button>}
            {canFork && inspectTurn && turn.status !== "inProgress" && <Button type="button" variant="ghost" size="xs" className="side-bring-action"
              aria-label={t("chat.selection.inspectSourceTurn")}
              onClick={() => document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(inspectTurn)}"]`)?.scrollIntoView({ block: "center" })}>{t("chat.selection.inspectSource")}</Button>}
          </>;
          const segments = executionSegments(turn.items ?? [], turn.status);
          const hasFinal = segments.some((item: Data) => item.type === "agentMessage" && item.phase === "final_answer" && item.text?.trim());
          const finalMessage = segments.findLast((item: Data) => item.type === "agentMessage" && item.phase === "final_answer" && item.text?.trim());
          // Old snapshots have no phases. A completed text-tail allows a purely
          // chronological disclosure; it does not classify or rewrite any message.
          // Unsettled work, pending input and terminal exceptions stay inspectable.
          const tail = segments.at(-1);
          const pendingInput = project.state?.interactions?.[thread.id]?.data?.some((item: Data) => item.status === "pending" && item.turnId === turn.id);
          const legacyReply = turn.status === "completed" && tail?.type === "agentMessage" &&
            segments.every((item: Data) => item.type !== "agentMessage" || item.phase == null) &&
            !executionOutcome(segments.flatMap((item: Data) => item.items ?? [])).unfinished &&
            !pendingInput ? tail : undefined;
          const responseMessage = finalMessage ?? legacyReply;
          const hasReadingSummary = hasFinal || !!legacyReply;
          // 带phase与旧快照共用同一过程总组；从运行期起保留挂载，
          // 完成收敛只隐藏内容，不重置工具详情或改变历史顺序。
          const groups: { id: string; progress: boolean; entries: { item: Data; index: number }[] }[] = [];
          segments.forEach((item: Data, index: number) => {
            const progress = item.type !== "historyDeferred" && item.type !== "questionAnswer" && item.type !== "userMessage" && item.type !== "agentMedia" && (item.type !== "agentMessage" || item.phase === "commentary" || (!!legacyReply && item.id !== legacyReply.id));
            const previous = groups.at(-1);
            if (progress && previous?.progress) previous.entries.push({ item, index });
            // An earlier empty commentary can become visible after the reader
            // opens tools. Anchor its group to the preceding reading boundary
            // so that insertion retains both disclosure levels.
            else groups.push({ id: progress ? `progress:${previous?.id ?? turn.id}` : item.id, progress, entries: [{ item, index }] });
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
          const hasInterruption = turn.status === "interrupted" || turn.status === "failed" && !!turn.interruption;
          const stopHeading = <div className="turn-stop-heading turn-progress-heading">
            <div className="turn-progress-label"><span className="turn-status turn-progress-summary" role="status">{ordinary ? interruptionLabel(turn) : "已停止"}{turn.error ? `：${turnFailureMessage(turn)}` : ""}</span></div>
            <div className="turn-progress-divider" />
          </div>;
          return <section key={turn.id} data-turn-id={turn.id} data-turn-status={turn.status} data-latest-turn={turn.id === latestTurnId}>
            {stopAccepted && <p role="status">{ordinary ? "暂停已受理，等待执行结算" : "停止已受理，等待执行结算"}</p>}
            {resourceLabel && <p role="status">{resourceLabel}</p>}
            {groups.map((group, groupIndex) => {
            const outcome = executionOutcome(group.entries.flatMap(({ item }) => item.items ?? []));
            const contents = group.entries.map(({ item, index }) => {
              if (item.type === "historyDeferred") return <DeferredHistoryItem key={item.id} item={item}
                loading={localThread.displayHistory?.loadingItems?.[item.id]}
                error={history.failure?.itemId === item.id ? history.failure?.message : undefined}
                onLoad={() => { readHere(); void history.load(item.id); }} />;
              if (item.type === "questionAnswer") return <div className="user-message" data-question-answer={item.id} key={item.id}>
                <div className="user-message-content"><div className="user-bubble question-answer-bubble">
                  {item.questions.map((question: Data) => <div key={question.id}>
                    <p className="question-answer-title">{question.title}</p>
                    <p>{item.answers[question.id]}</p>
                  </div>)}
                </div></div>
              </div>;
              if (item.type === "userMessage") {
                const continuation = turn.continuedFromTurnId ? "继续执行" : goalContinuationLabel(turn);
                if (continuation && item.id === turn.items?.find((entry: Data) => entry.type === "userMessage")?.id) {
                  return <div className="turn-status" key={item.id}>{continuation}</div>;
                }
                const content = item.content ?? [];
                const appContent = content.filter((part: Data) => part.type === "text" && part.mcpContent);
                const text = content.filter((part: Data) => part.type === "text" && !part.mcpContent).map((part: Data) => part.text ?? "").join("\n");
                const feedback = sentReviewFeedback(text);
                const attachments: Data[] = content.filter((part: Data) => part.type !== "text");
                const browserFeedback = sentBrowserAnnotations(feedback.text, attachments);
                const imageFeedback = sentImageAnnotations(browserFeedback.text, attachments);
                const ordinaryAttachments = attachments.map((part: Data, index: number) => ({ part, index })).filter(({ part }) => !browserFeedback.notes.some(note => note.imageUri === (part.url ?? part.uri)));
                return (
                  <Fragment key={item.id}><div className="user-message" data-side-item-id={item.id}>
                    <div className="user-message-content">
                      <SentReviewComments comments={feedback.comments} />
                      {appContent.length>0&&<div className="user-attachments" aria-label="应用内容">{appContent.map((part:Data,index:number)=><McpContentLabel key={index} block={part.mcpContent}/>)}</div>}
                      <SentBrowserAnnotations notes={browserFeedback.notes} attachments={attachments} projectId={project.id} threadId={thread.id} action={action} />
                      {ordinaryAttachments.length > 0 ? <div className="user-attachments" data-testid="user-attachments">
                        {ordinaryAttachments.map(({ part, index }) => {
                          const note = imageFeedback.notes.find(note => note.attachmentIndex === index);
                          return <div key={`${index}:${part.url ?? part.uri}`} className="flex flex-col gap-2"><SentAttachment
                            part={part} annotation={note} projectId={project.id} threadId={thread.id} action={action} />{note && <ImageAnnotationList note={note} />}</div>;
                        })}
                      </div> : null}
                      {imageFeedback.text.trim() ? <div className="user-bubble">
                        <CollapsibleText key={`${owner}:${item.id}`} onExpandedChange={() => {
                          follow.current = false;
                          releaseResponseSpace();
                          rememberReading();
                        }}>
                        <UserMessageBody theme={dark ? "dark" : "light"} onOpenExternalUrl={onLink} onOpenFileLink={onFile}>{imageFeedback.text}</UserMessageBody>
                        </CollapsibleText>
                      </div> : null}
                      {(text.trim() || item.id === editable) && <MessageActions text={text}>{item.id === editable && <UserPromptEdit key={`${owner}:${item.id}`} project={project} thread={localThread} item={item} action={action} />}</MessageActions>}
                    </div>
                  </div>
                  {turn.id === creationAnchor && item.id === initialUser?.id && <WorktreeStatus events={localThread.worktreeEvents} current={localThread.worktree} />}</Fragment>
                );
              }
              if (item.type === "agentMessage") return renderAgentMessage(item, turn, item.id === finalMessage?.id);
              if (item.type === "agentMedia") return <div className="assistant-media flex flex-wrap gap-2" key={item.id}>
                <SentAttachment part={{ type: item.modality, uri: item.media.uri,
                  name: item.modality === "image" ? "生成的图片" : item.modality === "audio" ? "生成的音频" : "生成的文件" }}
                  projectId={project.id} threadId={thread.id} action={action} />
              </div>;
              return <TurnExecution key={item.id} items={item.items} turn={turn} project={project} threadId={thread.id}
                renderItem={(entry: Data, disclosure) => {
                  if (entry.type === "dynamicToolCall") return <div data-side-item-id={entry.id} key={entry.id}><ToolEvent item={entry} {...disclosure} onOpenResult={(ordinary || localThread.conversation?.policy?.kind === "sideExecutableV2") && !readOnly && !isInherited && !localThread.desktop?.archived ? onOpenResult : undefined} resultState={resultStates?.[mcpResultKey({ projectId: project.id, threadId: thread.id, turnId: turn.id, itemId: entry.id })]} onFile={onFile} onAgent={isInherited ? undefined : onAgent} agents={isInherited ? undefined : project.state?.threads} turnId={turn.id} action={action} projectId={project.id} threadId={thread.id} readTurnReview={turn.status === "completed" ? readTurnReview : undefined} /></div>;
                  if (entry.type === "modelContext") return null;
                  return <details className="tool-call" data-side-item-id={entry.id} key={entry.id}><summary>{entry.type}</summary><pre>{JSON.stringify(entry, null, 2)}</pre></details>;
                }} />;
            });
            return <Fragment key={group.id}>
              {localThread.displayHistory?.omitted && group.entries.some(({ item }) => item.id === localThread.displayHistory.baselineFirstItemId
                || item.items?.some((entry: Data) => entry.id === localThread.displayHistory.baselineFirstItemId)) &&
                <p role="status" className="notice">{t("chat.history.omitted")}</p>}
              {hasInterruption && groupIndex === stopHeaderIndex && stopHeading}
              {group.progress ? <TurnProgress summaryAvailable
                turn={groupIndex === firstProgress ? turn : undefined} connected={!!project.state?.connected}
                label={legacyReply ? "早前消息与活动" : "本轮过程"}
                settled={turn.status === "completed" && hasReadingSummary && !outcome.unfinished && !pendingInput}
                failureDetails={group.entries.flatMap(({ item }) => item.items ?? []).filter((entry: Data) => entry.type === "dynamicToolCall" && toolPresentation(entry).failed).map((entry: Data) => <div key={entry.id}><p>{entry.tool}</p><pre>{JSON.stringify(entry, null, 2)}</pre></div>)}
                {...outcome}>{contents}</TurnProgress> : contents}
              {group.entries.some(({ item }) => item === initialUser) &&
                firstProgress < 0 &&
                <TurnElapsed turn={turn} connected={!!project.state?.connected} />}
            </Fragment>;
            })}
            {!isInherited && (turn.items ?? []).filter((item: Data) => item.type === "dynamicToolCall").map((item: Data) =>
              <UnknownToolInspection key={`${project.id}:${thread.id}:${item.id}`} item={item} project={readOnly ? { ...project, state: { ...project.state, connected: false } } : project} thread={thread} action={action} />)}
            <ScheduledTaskCards items={turn.items ?? []} project={project} action={action} />
            <TurnFileSummary turn={turn} readTurnReview={readTurnReview} onFile={onFile} onReview={onReview} />
            {responseMessage && turn.status !== "inProgress" ? <MessageActions text={conversationContentToText(projectConversationContent(responseMessage.text, turn.status === "completed", false))}><TurnHookStats turn={turn} /><TurnUsage project={project} thread={localThread} turn={turn} action={action} inherited={isInherited} />{forkControls}{responseActions?.(responseMessage)}{!isInherited && !readOnly && <UserFeedback project={project} thread={localThread} turn={turn} item={responseMessage} action={action} dark={dark} />}</MessageActions>
              : <div className="message-actions"><TurnUsage project={project} thread={localThread} turn={turn} action={action} inherited={isInherited} />{forkControls}</div>}
            {canFork && forkReason && turn.status !== "inProgress" && <p id={`fork-reason-${turn.id}`} className="notice">{forkReason}</p>}
            {canFork && forkError?.turnId === turn.id && <p role="alert" className="notice">{forkError?.message}</p>}
            {hasInterruption && stopHeaderIndex < 0 && stopHeading}
            {turn.status !== "inProgress" && !hasInterruption && !(turn.status === "completed" && hasReadingSummary) && (
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
            <TurnActivity turn={turn} project={project} threadId={thread.id} />
          </section>;
        })}
        {afterTurns}
      </div>
      {!embedded && <div ref={responseSpace} className="message-response-space" aria-hidden="true" />}
    </div>
    {selectedSideText?.owner === selectionOwner && (onAddSelection || onSideSelection) && <Popover open onOpenChange={open => { if (!open) setSelectedSideText(null); }}>
      <PopoverContent anchor={{ getBoundingClientRect: () => selectedSideText.rect }} side="top" initialFocus={false} finalFocus={false}
        data-testid="transcript-selection-actions" aria-label={t("chat.selection.actions")}
        className="w-auto flex-row gap-inline p-1" onMouseDown={event => event.preventDefault()}>
        {onAddSelection && <Button type="button" variant="ghost" size="sm" onClick={() => {
          const chosen = selectionSnapshot.current;
          if (!chosen || !selectionIsCurrent(chosen)) return;
          onAddSelection(referenceFor(chosen)); setSelectedSideText(null);
        }}>{t("chat.selection.addToChat")}</Button>}
        {onSideSelection && <Button type="button" variant="ghost" size="sm" aria-label={t("chat.selection.askInSideChat")}
          onClick={() => void askAboutSelection()}>{t("chat.selection.ask")}</Button>}
      </PopoverContent>
    </Popover>}
    {!embedded && readingHistory && <TimelineBottomButton onClick={returnToBottom} />}
    </div>
  );
}
