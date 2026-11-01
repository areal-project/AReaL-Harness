import type { ReadingAnchor } from "./readingViews.js";
function readingBlocks(item: HTMLElement) {
  return [...(item.querySelector<HTMLElement>(".conversation-markdown")?.children ?? [])].filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );
}
/** 时间线的轮次分区，按文档顺序自上而下排列。 */
export function turnSections(element: HTMLElement) {
  return [
    ...element.querySelectorAll<HTMLElement>(":scope > .message-column > section[data-turn-id]"),
  ];
}
/** 第一个底边低于 y 的轮次下标；轮次纵向依次排列，可二分，滚动时不必逐条量位置。 */
export function firstTurnBelow(sections: readonly HTMLElement[], y: number) {
  let low = 0,
    high = sections.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sections[middle].getBoundingClientRect().bottom <= y) low = middle + 1;
    else high = middle;
  }
  return low;
}
/** 最后一个顶边不低于 y 的轮次下标；没有时为 -1。 */
export function lastTurnAbove(sections: readonly HTMLElement[], y: number) {
  let low = 0,
    high = sections.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sections[middle].getBoundingClientRect().top <= y) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
function* visibleItems(element: HTMLElement, viewport: DOMRect) {
  const sections = turnSections(element);
  if (!sections.length) {
    yield* element.querySelectorAll<HTMLElement>("[data-side-item-id]");
    return;
  }
  // 视口上方的轮次整体不可见，从第一个与视口相交的轮次开始逐条检查。
  for (let index = firstTurnBelow(sections, viewport.top); index < sections.length; index++) {
    if (sections[index].getBoundingClientRect().top >= viewport.bottom) return;
    yield* sections[index].querySelectorAll<HTMLElement>("[data-side-item-id]");
  }
}
export function readingAnchor(element: HTMLElement): ReadingAnchor | undefined {
  const viewport = element.getBoundingClientRect();
  for (const item of visibleItems(element, viewport)) {
    const turnId = item.closest<HTMLElement>("[data-turn-id]")?.dataset.turnId;
    if (!turnId || !item.dataset.sideItemId) continue;
    const blocks = readingBlocks(item);
    const blockIndex = blocks.findIndex(
      (block) =>
        block.getBoundingClientRect().bottom > viewport.top &&
        block.getBoundingClientRect().top < viewport.bottom,
    );
    const block = blocks[blockIndex] ?? item;
    const box = block.getBoundingClientRect();
    if (box.bottom > viewport.top && box.top < viewport.bottom)
      return {
        turnId,
        itemId: item.dataset.sideItemId,
        blockIndex: blockIndex < 0 ? null : blockIndex,
        offset: box.top - viewport.top,
      };
  }
}
export function restoreReadingAnchor(element: HTMLElement, anchor: ReadingAnchor) {
  const turn = [...element.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
    (turn) => turn.dataset.turnId === anchor.turnId,
  );
  const item = [...(turn?.querySelectorAll<HTMLElement>("[data-side-item-id]") ?? [])].find(
    (item) => item.dataset.sideItemId === anchor.itemId,
  );
  if (item?.querySelector("[data-reading-pending]")) return "pending";
  const block =
    item && (anchor.blockIndex === null ? item : readingBlocks(item)[anchor.blockIndex]);
  if (!block) return false;
  const box = block.getBoundingClientRect();
  if (box.height <= 0 || element.clientHeight <= 0) return false;
  const offset = Math.max(1 - box.height, anchor.offset);
  element.scrollTop += box.top - element.getBoundingClientRect().top - offset;
  return (
    Math.abs(block.getBoundingClientRect().top - element.getBoundingClientRect().top - offset) <= 1
  );
}
