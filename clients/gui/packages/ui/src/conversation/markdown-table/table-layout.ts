export type MarkdownTableEdgeShadowState = "none" | "left" | "right" | "both";

export type MarkdownTableRows = string[][];

export type MarkdownTableFrameDistances = {
  leftDistance: number;
  maxLeftOffset: number;
  scrollbarWidth: number;
  rightDistance: number;
  maxViewportWidth: number;
};

export type MarkdownTableVirtualScrollbarMetrics = {
  contentWidth: number;
  thumbLeft: number;
  thumbWidth: number;
};

export type MarkdownTableObservedRect = {
  left: number;
  right: number;
  width: number;
};

export const MARKDOWN_TABLE_ROOT_SELECTOR =
  '[data-markdown-table-layout-root="true"], [data-testid="chat-view"]';
export const MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR =
  '[data-markdown-table-sticky-scrollbar="disabled"]';
export const MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR = '[data-v4-composer-dock="true"]';
export const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR =
  '[data-v4-back-to-bottom-anchor="composer-dock"] button';
export const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX = 8;
export const MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX = 32;
export const MARKDOWN_TABLE_CONTENT_PADDING_LG_PX = 16;
export const MARKDOWN_TABLE_CONTENT_PADDING_MD_PX = 8;
export const MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO = 0.8;
export const MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY = "--markdown-table-layout-left-inset";
export const MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY = "--markdown-table-layout-right-inset";

export function normalizeTableCellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function escapeCsvCell(value: string): string {
  // assistant markdown 属于不可信输入，CSV 被 Excel/Numbers/LibreOffice
  // 打开时会解释公式前缀。下载前统一把公式型单元格降级成纯文本。
  const safeValue = /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function buildMarkdownTableText(rows: MarkdownTableRows): string {
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? "")),
  );
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);

  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function buildCsvTableText(rows: MarkdownTableRows): string {
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  // Blob 的 charset 不会写入文件字节，Excel 会把无 BOM 的 UTF-8 CSV
  // 按本地代码页解析，导致中文乱码；显式添加 UTF-8 BOM 让表格软件可靠识别编码。
  return `\uFEFF${csv}`;
}

export function readRowsFromTable(table: HTMLTableElement | null): MarkdownTableRows {
  if (!table) {
    return [];
  }

  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        normalizeTableCellText(cell.textContent ?? ""),
      ),
    )
    .filter((row) => row.length > 0);
}

export function resolveMarkdownTableRoot(
  frame: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  // V4 删除旧 ChatView 后不再渲染 data-testid="chat-view"，表格会退回自身宽度，
  // 因而误判增强横向滚动没有收益。优先使用跨版本的显式布局边界，旧选择器只保留兼容。
  return frame?.closest<HTMLElement>(MARKDOWN_TABLE_ROOT_SELECTOR) ?? fallbackRoot;
}

export function getMarkdownTableContentInlineInsetPx() {
  if (typeof window === "undefined") {
    return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
  }

  // 表格宽度借用 ChatView root 右侧空间时，需要扣掉消息列本身的响应式右 padding。
  // 对应 ChatConversationContent 的 px-8 max-lg:px-4 max-md:px-2。
  if (window.innerWidth < 768) {
    return MARKDOWN_TABLE_CONTENT_PADDING_MD_PX;
  }

  if (window.innerWidth < 1024) {
    return MARKDOWN_TABLE_CONTENT_PADDING_LG_PX;
  }

  return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
}

export function getMarkdownTableRootInlineInsets(root: HTMLElement) {
  if (typeof window !== "undefined" && root.matches('[data-markdown-table-layout-root="true"]')) {
    return {
      leftInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY),
      rightInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY),
    };
  }

  const legacyInset = getMarkdownTableContentInlineInsetPx();
  return { leftInset: legacyInset, rightInset: legacyInset };
}

export function readMarkdownTableObservedRect(
  element: HTMLElement | null,
): MarkdownTableObservedRect | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
  };
}

export function isMarkdownTableObservedRectEqual(
  leftRect: MarkdownTableObservedRect | null,
  rightRect: MarkdownTableObservedRect | null,
) {
  return (
    leftRect?.left === rightRect?.left &&
    leftRect?.right === rightRect?.right &&
    leftRect?.width === rightRect?.width
  );
}

export function readCssPixelValue(element: HTMLElement | null, propertyName: string) {
  if (!element || typeof window === "undefined") {
    return 0;
  }

  const value = window.getComputedStyle(element).getPropertyValue(propertyName);
  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
}

export function readMarkdownTableDockHeight(root: HTMLElement | null) {
  const legacyDockHeight = readCssPixelValue(root, "--chat-bottom-dock-height");
  if (legacyDockHeight > 0) return legacyDockHeight;

  // V4 composer dock 位于 timeline 滚动视口内部，但不再设置旧 ChatView 的
  // CSS 变量。直接读取真实 dock 高度，避免吸底滚动条被输入区覆盖。
  return (
    root
      ?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR)
      ?.getBoundingClientRect().height ?? 0
  );
}

export function readMarkdownTableBackToBottomClearance(root: HTMLElement | null) {
  const button = root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR);
  if (!button) return 0;

  return button.getBoundingClientRect().height + MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX;
}

export function resolveMarkdownTableVerticalViewport(
  element: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  if (typeof window === "undefined") {
    return fallbackRoot;
  }

  let currentElement = element?.parentElement ?? null;
  while (currentElement) {
    const style = window.getComputedStyle(currentElement);
    const canScrollY = /auto|scroll|overlay/u.test(style.overflowY);
    // 横向滚动 viewport 因 overflow-x-auto 可能让浏览器把 overflow-y 计算成 auto；
    // 如果不确认真的存在纵向滚动空间，短表格会把自身高度误当成可视区域高度，导致 80% 判定永远成立。
    const hasVerticalScrollRange = currentElement.scrollHeight > currentElement.clientHeight + 1;
    if (canScrollY && currentElement.clientHeight > 0 && hasVerticalScrollRange) {
      return currentElement;
    }
    currentElement = currentElement.parentElement;
  }

  return fallbackRoot;
}

export function resolveMarkdownTableStickyScrollbarMode({
  stickyScrollbarDisabled,
  viewportHeight,
  dockHeight,
  tableHeight,
}: {
  stickyScrollbarDisabled: boolean;
  viewportHeight: number;
  dockHeight: number;
  tableHeight: number;
}) {
  if (stickyScrollbarDisabled) {
    return false;
  }

  const visibleHeight = Math.max(0, viewportHeight - dockHeight);
  return (
    visibleHeight > 0 && tableHeight > visibleHeight * MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO
  );
}

export function resolveMarkdownTableStickyScrollbarOffset({
  frameTop,
  frameBottom,
  scrollbarHeight,
  viewportBottom,
}: {
  frameTop: number;
  frameBottom: number;
  scrollbarHeight: number;
  viewportBottom: number;
}) {
  const minimumBottom = Math.min(frameBottom, frameTop + Math.max(0, scrollbarHeight));
  const pinnedBottom = Math.min(frameBottom, Math.max(minimumBottom, viewportBottom));
  return Math.min(0, pinnedBottom - frameBottom);
}

export function shouldUseMarkdownTableStickyScrollbar({
  root,
  table,
}: {
  root: HTMLElement | null;
  table: HTMLTableElement | null;
}) {
  if (!table) {
    return false;
  }

  const viewport = resolveMarkdownTableVerticalViewport(table, root);
  const viewportHeight =
    viewport?.clientHeight ||
    viewport?.getBoundingClientRect().height ||
    (typeof window === "undefined" ? 0 : window.innerHeight);
  const dockHeight = readMarkdownTableDockHeight(root);
  const tableHeight = table.getBoundingClientRect().height;

  // subagent prompt/output 会继承会话 dock 高度；如果也启用 sticky，虚拟滚动条会在
  // 嵌套容器内错误上抬到表格中段。显式 opt-out 不依赖容器当前是否已经产生纵向 overflow。
  return resolveMarkdownTableStickyScrollbarMode({
    stickyScrollbarDisabled: table.closest(MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR) !== null,
    viewportHeight,
    dockHeight,
    tableHeight,
  });
}

export function resolveMarkdownTableFrameDistances({
  frameWidth,
  frameLeft,
  frameRight,
  rootLeft,
  rootRight,
  leftInset = 0,
  rightInset = 0,
}: {
  frameWidth: number;
  frameLeft: number;
  frameRight: number;
  rootLeft: number;
  rootRight: number;
  leftInset?: number;
  rightInset?: number;
}): MarkdownTableFrameDistances {
  const leftDistance = Math.max(0, frameLeft - rootLeft);
  const rightDistance = Math.max(0, rootRight - frameRight);
  const maxLeftOffset = Math.max(0, leftDistance - leftInset);
  const scrollbarWidth = Math.max(0, frameWidth + rightDistance - rightInset);

  return {
    leftDistance,
    maxLeftOffset,
    scrollbarWidth,
    rightDistance,
    maxViewportWidth: scrollbarWidth,
  };
}

export function resolveMarkdownTableVirtualScrollbarMetrics({
  scrollLeft,
  scrollMax,
  tableWidth,
  trackWidth,
}: {
  scrollLeft: number;
  scrollMax: number;
  tableWidth: number;
  trackWidth: number;
}): MarkdownTableVirtualScrollbarMetrics {
  const safeTableWidth = Math.max(0, tableWidth);
  const safeTrackWidth = Math.max(0, trackWidth);
  const safeScrollMax = Math.max(0, scrollMax);
  const contentWidth = Math.max(safeTrackWidth, safeTableWidth);

  if (safeTrackWidth <= 0 || safeScrollMax <= 1 || safeTableWidth <= safeTrackWidth) {
    return {
      contentWidth: safeTrackWidth,
      thumbLeft: 0,
      thumbWidth: safeTrackWidth,
    };
  }

  const thumbWidth = Math.min(
    safeTrackWidth,
    Math.max(0, safeTrackWidth * (safeTrackWidth / safeTableWidth)),
  );
  const maxThumbLeft = Math.max(0, safeTrackWidth - thumbWidth);
  const thumbLeft = Math.min(
    maxThumbLeft,
    Math.max(0, Math.max(0, scrollLeft) * (safeTrackWidth / safeTableWidth)),
  );

  return {
    contentWidth,
    thumbLeft,
    thumbWidth,
  };
}

export function resolveMarkdownTableVirtualScrollMax({
  tableWidth,
  trackWidth,
}: {
  tableWidth: number;
  trackWidth: number;
}): number {
  return Math.max(0, tableWidth - trackWidth);
}
