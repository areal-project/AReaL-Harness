import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ComponentProps,
} from "react";
import type { Messages } from "./Messages.js";
import type { Data } from "./services.js";
import type {
  ConversationSelectionReference,
  ConversationSelectionContentType,
} from "./conversationSelectionReference.js";
type TranscriptSelectionSnapshot = {
  owner: string;
  text: string;
  turnId: string;
  itemId: string;
  contentType: ConversationSelectionContentType;
  range: Range;
  rect: DOMRect;
  provenance: { kind: "userQuote" } | { kind: "itemRange"; startUtf8: number; endUtf8: number };
};

export function useTranscriptSelection({
  project,
  thread,
  container,
  onAddSelection,
  onSideSelection,
  readOnly,
}: Pick<
  ComponentProps<typeof Messages>,
  "project" | "onAddSelection" | "onSideSelection" | "readOnly"
> & { thread: Data; container: RefObject<HTMLDivElement | null> }) {
  const selectionOwner = JSON.stringify([
    project.core?.instanceId,
    project.core?.connectionGeneration,
    project.id,
    thread.id,
  ]);
  const currentSelectionOwner = useRef(selectionOwner);
  currentSelectionOwner.current = selectionOwner;
  const [selectedSideText, updateSelection] = useState<TranscriptSelectionSnapshot | null>(null);
  const selectionSnapshot = useRef<TranscriptSelectionSnapshot | null>(null);
  const setSelectedSideText = (next: TranscriptSelectionSnapshot | null) => {
    selectionSnapshot.current = next;
    updateSelection(next);
  };
  useLayoutEffect(() => {
    setSelectedSideText(null);
  }, [selectionOwner, !!onAddSelection, !!onSideSelection, readOnly]);
  const selectionIsCurrent = (chosen: TranscriptSelectionSnapshot) => {
    const selected = window.getSelection();
    return (
      currentSelectionOwner.current === chosen.owner &&
      selectionSnapshot.current === chosen &&
      chosen.range.startContainer.isConnected &&
      chosen.range.endContainer.isConnected &&
      !!container.current?.contains(chosen.range.commonAncestorContainer) &&
      selected?.rangeCount === 1 &&
      !selected.isCollapsed &&
      selected.toString() === chosen.text &&
      selected.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, chosen.range) === 0 &&
      selected.getRangeAt(0).compareBoundaryPoints(Range.END_TO_END, chosen.range) === 0 &&
      chosen.range.toString() === chosen.text
    );
  };
  useEffect(() => {
    const invalidate = () => {
      const chosen = selectionSnapshot.current;
      if (chosen && !selectionIsCurrent(chosen)) setSelectedSideText(null);
    };
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
    const start = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement
    )?.closest<HTMLElement>("[data-side-item-id]");
    const end = (
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? (range.endContainer as Element)
        : range.endContainer.parentElement
    )?.closest<HTMLElement>("[data-side-item-id]");
    if (
      !start ||
      start !== end ||
      !container.current?.contains(start) ||
      !container.current.contains(range.commonAncestorContainer)
    )
      return;
    const selectedElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    if (selectedElement?.closest("button, input, textarea, [contenteditable='true']")) return;
    const text = selected.toString();
    if (!text.trim()) return;
    const turnId = start.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId;
    const itemId = start.dataset.sideItemId;
    if (!turnId || !itemId) return;
    const sourceTurn = (thread.turns ?? []).find((turn: Data) => turn.id === turnId);
    const canonical = sourceTurn?.items?.find((item: Data) => item.id === itemId);
    if (!canonical) return;
    const contentType: ConversationSelectionContentType =
      canonical.type === "userMessage"
        ? "user"
        : canonical.type === "agentMessage"
          ? "assistant"
          : canonical.type === "reasoning"
            ? "reasoning"
            : "tool";
    const snapshot = {
      owner: selectionOwner,
      text,
      turnId,
      itemId,
      contentType,
      range: range.cloneRange(),
      rect: range.getBoundingClientRect(),
    };
    // 流式回复的增量尚未确认持久化；DOM 相等不能证明选区属于冻结证据。
    const streamingReply =
      sourceTurn?.status === "inProgress" && canonical?.type === "agentMessage";
    const canonicalText =
      canonical?.type === "agentMessage"
        ? canonical.text
        : canonical?.type === "userMessage" &&
            canonical.content?.length === 1 &&
            canonical.content[0].type === "text"
          ? canonical.content[0].text
          : canonical?.type === "dynamicToolCall" &&
              canonical.success === true &&
              canonical.contentItems?.length === 1
            ? canonical.contentItems[0]?.text
            : undefined;
    const body =
      canonical?.type === "dynamicToolCall"
        ? start.querySelector<HTMLElement>("[aria-label='工具结果']")
        : start.querySelector<HTMLElement>(".conversation-markdown");
    if (
      !streamingReply &&
      canonicalText &&
      body &&
      body.textContent === canonicalText &&
      body.contains(range.startContainer) &&
      body.contains(range.endContainer)
    ) {
      const prefix = range.cloneRange();
      prefix.selectNodeContents(body);
      prefix.setEnd(range.startContainer, range.startOffset);
      const startUtf8 = new TextEncoder().encode(prefix.toString()).length;
      const endUtf8 = startUtf8 + new TextEncoder().encode(text).length;
      setSelectedSideText({ ...snapshot, provenance: { kind: "itemRange", startUtf8, endUtf8 } });
    } else setSelectedSideText({ ...snapshot, provenance: { kind: "userQuote" } });
  };
  const referenceFor = (chosen: TranscriptSelectionSnapshot): ConversationSelectionReference => ({
    id: crypto.randomUUID(),
    sourceSessionId: thread.id,
    sourceRowId: `${chosen.turnId}:${chosen.itemId}`,
    contentType: chosen.contentType,
    text: chosen.text,
  });
  const askAboutSelection = async () => {
    const chosen = selectedSideText;
    if (!chosen || !selectionIsCurrent(chosen) || !onSideSelection) return;
    let selection: Data = {
      kind: "userQuote",
      text: chosen.text,
      claimedTurnId: chosen.turnId,
      claimedItemId: chosen.itemId,
    };
    if (chosen.provenance.kind === "itemRange") {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chosen.text));
      selection = {
        kind: "itemRange",
        turnId: chosen.turnId,
        itemId: chosen.itemId,
        startUtf8: chosen.provenance.startUtf8,
        endUtf8: chosen.provenance.endUtf8,
        textSha256: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      };
    }
    // 计算摘要期间也可能切换来源；旧回调不能把选区交给新会话。
    if (!selectionIsCurrent(chosen)) return;
    const turn = (thread.turns ?? []).find((item: Data) => item.id === chosen.turnId);
    onSideSelection(
      selection,
      chosen.text,
      turn?.status === "completed"
        ? { kind: "turn", turnId: chosen.turnId, boundary: "after" }
        : undefined,
      referenceFor(chosen),
    );
    setSelectedSideText(null);
  };
  return {
    selectedSideText,
    setSelectedSideText,
    selectionIsCurrent,
    captureSideSelection,
    referenceFor,
    askAboutSelection,
    selectionOwner,
    selectionSnapshot,
  };
}
