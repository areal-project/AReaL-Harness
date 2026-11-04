import type { ReadingWindow, HistoryPage, ReadingTarget } from "./host-services.js";
import { pageTopology } from "@areal/workbench/history-projection";

const historyPageLimit = 16,
  historyTopologyBytes = 64 * 1024;
export const encodedBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export function pinnedPage(readingWindow: ReadingWindow, page: HistoryPage) {
  return [...readingWindow.targets.values()].some(
    ({ anchor }) =>
      anchor &&
      page.data.some(
        (entry) => entry.sourceTurnId === anchor.turnId && entry.sourceItemId === anchor.itemId,
      ),
  );
}
export function retainTarget(
  owner: ReadingWindow,
  viewId: string,
  revision: number,
  anchor: ReadingTarget["anchor"],
) {
  const previous = owner.targets.get(viewId);
  if (
    previous &&
    (revision < previous.revision ||
      (revision === previous.revision &&
        JSON.stringify(anchor) !== JSON.stringify(previous.anchor)))
  )
    return undefined;
  if (previous?.revision === revision) return previous;
  const intent = { revision, anchor };
  owner.targets.set(viewId, intent);
  return intent;
}
export function cacheHistoryPages(
  owner: ReadingWindow,
  input: HistoryPage[],
  startCursor?: string,
  scanned = input,
) {
  const canonical = (page: HistoryPage) => ({
    ...page,
    pageId: owner.pageRecords.find((record) => record.cursor === page.cursor)?.id ?? page.pageId,
  });
  const incoming = input.map(canonical);
  const records = [...owner.pageRecords];
  for (const page of scanned.map(canonical)) {
    const record = { id: page.pageId, cursor: page.cursor, items: pageTopology(page.data) };
    const index = records.findIndex((value) => value.cursor === page.cursor);
    if (index < 0) records.push(record);
    else records[index] = record;
  }
  const replaced = new Set(
    incoming.flatMap((page) => page.data.map((entry) => entry.sourceItemId)),
  );
  const stale = owner.stalePages
    .map((page) => ({
      ...page,
      data: page.data.filter((entry) => !replaced.has(entry.sourceItemId)),
    }))
    .filter((page) => page.data.length && pinnedPage(owner, page));
  const pages = [
    ...owner.pages.filter((page) => !incoming.some((next) => next.pageId === page.pageId)),
    ...incoming,
  ];
  const target = incoming.at(-1)?.pageId;
  const position = (id: string) => records.findIndex((record) => record.id === id);
  const targetIndex = target ? position(target) : -1;
  while (pages.length + stale.length > historyPageLimit) {
    const victim = pages
      .filter((page) => page.pageId !== target && !pinnedPage(owner, page))
      .sort(
        (a, b) =>
          Math.abs(position(b.pageId) - targetIndex) - Math.abs(position(a.pageId) - targetIndex),
      )[0];
    if (!victim) return false;
    pages.splice(pages.indexOf(victim), 1);
  }
  const resident = new Set(pages.map((page) => page.pageId));
  const pinned = new Set(
    pages.filter((page) => pinnedPage(owner, page)).map((page) => page.pageId),
  );
  let bytes = 2;
  const topology = new Set<string>();
  for (const record of [...records].sort(
    (a, b) =>
      Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
      Number(resident.has(b.id)) - Number(resident.has(a.id)) ||
      Math.abs(position(a.id) - targetIndex) - Math.abs(position(b.id) - targetIndex),
  )) {
    const size = encodedBytes({ id: record.id, items: record.items }) + 1;
    if (record.items.length && bytes + size <= historyTopologyBytes) {
      bytes += size;
      topology.add(record.id);
    }
  }
  owner.pageRecords = records.map((record) =>
    topology.has(record.id) ? record : { ...record, items: [] },
  );
  owner.pages = pages;
  owner.stalePages = stale;
  const shown = new Set([
    ...owner.observation.thread.turns.flatMap((turn) => turn.items).map((item) => item.id),
    ...[...pages, ...stale].flatMap((page) => page.data.map((entry) => entry.sourceItemId)),
  ]);
  for (const id of owner.items.keys()) if (!shown.has(id)) owner.items.delete(id);
  if (owner.nextCursor === startCursor) {
    const last = incoming.at(-1);
    if (last) {
      owner.nextCursor = last.nextCursor ?? undefined;
      owner.complete = last.complete;
    }
  }
  return true;
}
