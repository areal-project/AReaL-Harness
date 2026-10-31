import type { ReadingAnchor } from "./readingViews.js";
function readingBlocks(item: HTMLElement) {
  return [...(item.querySelector<HTMLElement>(".conversation-markdown")?.children ?? [])].filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );
}
export function readingAnchor(element: HTMLElement): ReadingAnchor | undefined {
  const viewport = element.getBoundingClientRect();
  for (const item of element.querySelectorAll<HTMLElement>("[data-side-item-id]")) {
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
