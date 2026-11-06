"use client";

import type {
  ComponentProps,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeftFromLine,
  ArrowRightToLine,
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { observeResize } from "../../lib/observe-resize.js";
import { Button } from "../../components/button/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/dialog/dialog.js";
import { ControlHintTooltip } from "../../components/control-hint-tooltip/control-hint-tooltip.js";

import {
  type MarkdownTableEdgeShadowState,
  MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR,
  buildMarkdownTableText,
  buildCsvTableText,
  readRowsFromTable,
  resolveMarkdownTableRoot,
  getMarkdownTableRootInlineInsets,
  readMarkdownTableObservedRect,
  isMarkdownTableObservedRectEqual,
  readMarkdownTableDockHeight,
  readMarkdownTableBackToBottomClearance,
  resolveMarkdownTableVerticalViewport,
  resolveMarkdownTableStickyScrollbarOffset,
  shouldUseMarkdownTableStickyScrollbar,
  resolveMarkdownTableFrameDistances,
  resolveMarkdownTableVirtualScrollbarMetrics,
  resolveMarkdownTableVirtualScrollMax,
} from "./table-layout.js";
export {
  MarkdownTableRows,
  buildMarkdownTableText,
  buildCsvTableText,
  resolveMarkdownTableStickyScrollbarMode,
  resolveMarkdownTableStickyScrollbarOffset,
  resolveMarkdownTableFrameDistances,
  resolveMarkdownTableVirtualScrollbarMetrics,
  resolveMarkdownTableVirtualScrollMax,
} from "./table-layout.js";

type MarkdownTableNodeProp = {
  node?: unknown;
};

export type MarkdownTableLabels = {
  copyFailed: (error: string) => string;
  copySucceeded: string;
  downloadFailed: string;
  copyMarkdown: string;
  downloadCsv: string;
  openPreview: string;
  collapseScrollMode: string;
  expandScrollMode: string;
  previewTitle: string;
  previewDescription: string;
  closeDialog: string;
  scrollHint?: string;
};
const defaultLabels: MarkdownTableLabels = {
  copyFailed: (error) => `Copy failed: ${error}`,
  copySucceeded: "Copied",
  downloadFailed: "Download failed",
  copyMarkdown: "Copy Markdown",
  downloadCsv: "Download CSV",
  openPreview: "Open preview",
  collapseScrollMode: "Collapse",
  expandScrollMode: "Expand",
  previewTitle: "Table preview",
  previewDescription: "Read the complete table",
  closeDialog: "Close dialog",
};
const ignoreNotice = (_message: string, _tone: "success" | "error") => {};
export type MarkdownTableProps = ComponentProps<"table"> &
  MarkdownTableNodeProp & {
    sourceMarkdown?: string;
    labels?: MarkdownTableLabels;
    onNotify?: (message: string, tone: "success" | "error") => void;
  };

export function MarkdownTable({
  className,
  children,
  node: _node,
  sourceMarkdown,
  labels = defaultLabels,
  onNotify = ignoreNotice,
  ...props
}: MarkdownTableProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expandedScrollEnabled, setExpandedScrollEnabled] = useState(false);
  const [canToggleExpandedScroll, setCanToggleExpandedScroll] = useState(false);
  const [edgeShadowState, setEdgeShadowState] = useState<MarkdownTableEdgeShadowState>("none");
  const [viewportMaxWidth, setViewportMaxWidth] = useState<string>("100%");
  const [scrollbarWidth, setScrollbarWidth] = useState<string>("100%");
  const [viewportLeftOffset, setViewportLeftOffset] = useState(0);
  const [virtualScrollbarSticky, setVirtualScrollbarSticky] = useState(false);
  const [virtualScrollbarVisible, setVirtualScrollbarVisible] = useState(false);
  const [virtualScrollThumbStyle, setVirtualScrollThumbStyle] = useState<CSSProperties>({
    transform: "translateX(0px)",
    width: "100%",
  });
  const edgeShadowStateRef = useRef<MarkdownTableEdgeShadowState>("none");
  const expandedScrollEnabledRef = useRef(expandedScrollEnabled);
  const canToggleExpandedScrollRef = useRef(canToggleExpandedScroll);
  const viewportMaxWidthRef = useRef(viewportMaxWidth);
  const scrollbarWidthRef = useRef(scrollbarWidth);
  const viewportLeftOffsetRef = useRef(viewportLeftOffset);
  const virtualScrollbarStickyRef = useRef(virtualScrollbarSticky);
  const virtualScrollbarVisibleRef = useRef(virtualScrollbarVisible);
  const maxViewportLeftOffsetRef = useRef(0);
  const virtualScrollTrackWidthRef = useRef(0);
  const virtualScrollLeftRef = useRef(0);
  const virtualScrollThumbLeftRef = useRef(0);
  const virtualScrollThumbStyleRef = useRef(virtualScrollThumbStyle);
  const isVirtualScrollbarDraggingRef = useRef(false);
  const virtualScrollbarDragOffsetRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollTrackRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollbarWrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const previewButtonRef = useRef<HTMLButtonElement | null>(null);
  const setNextEdgeShadowState = useCallback(
    (nextEdgeShadowState: MarkdownTableEdgeShadowState) => {
      if (edgeShadowStateRef.current === nextEdgeShadowState) {
        return;
      }

      edgeShadowStateRef.current = nextEdgeShadowState;
      setEdgeShadowState(nextEdgeShadowState);
    },
    [],
  );
  const commitExpandedScrollEnabled = useCallback((nextExpandedScrollEnabled: boolean) => {
    if (expandedScrollEnabledRef.current === nextExpandedScrollEnabled) {
      return;
    }

    expandedScrollEnabledRef.current = nextExpandedScrollEnabled;
    setExpandedScrollEnabled(nextExpandedScrollEnabled);
  }, []);
  const commitCanToggleExpandedScroll = useCallback((nextCanToggleExpandedScroll: boolean) => {
    if (canToggleExpandedScrollRef.current === nextCanToggleExpandedScroll) {
      return;
    }

    canToggleExpandedScrollRef.current = nextCanToggleExpandedScroll;
    setCanToggleExpandedScroll(nextCanToggleExpandedScroll);
  }, []);
  const commitViewportMaxWidth = useCallback((nextViewportMaxWidth: string) => {
    if (viewportMaxWidthRef.current === nextViewportMaxWidth) {
      return;
    }

    viewportMaxWidthRef.current = nextViewportMaxWidth;
    setViewportMaxWidth(nextViewportMaxWidth);
  }, []);
  const commitScrollbarWidth = useCallback((nextScrollbarWidth: string) => {
    if (scrollbarWidthRef.current === nextScrollbarWidth) {
      return;
    }

    scrollbarWidthRef.current = nextScrollbarWidth;
    setScrollbarWidth(nextScrollbarWidth);
  }, []);
  const commitViewportLeftOffset = useCallback((nextViewportLeftOffset: number) => {
    if (viewportLeftOffsetRef.current === nextViewportLeftOffset) {
      return;
    }

    viewportLeftOffsetRef.current = nextViewportLeftOffset;
    setViewportLeftOffset(nextViewportLeftOffset);
  }, []);
  const commitVirtualScrollbarSticky = useCallback((nextVirtualScrollbarSticky: boolean) => {
    if (virtualScrollbarStickyRef.current === nextVirtualScrollbarSticky) {
      return;
    }

    virtualScrollbarStickyRef.current = nextVirtualScrollbarSticky;
    setVirtualScrollbarSticky(nextVirtualScrollbarSticky);
  }, []);
  const commitVirtualScrollbarVisible = useCallback((nextVirtualScrollbarVisible: boolean) => {
    if (virtualScrollbarVisibleRef.current === nextVirtualScrollbarVisible) {
      return;
    }

    virtualScrollbarVisibleRef.current = nextVirtualScrollbarVisible;
    setVirtualScrollbarVisible(nextVirtualScrollbarVisible);
  }, []);
  const commitVirtualScrollThumbStyle = useCallback(
    (nextVirtualScrollThumbStyle: CSSProperties) => {
      const currentStyle = virtualScrollThumbStyleRef.current;
      if (
        currentStyle.width === nextVirtualScrollThumbStyle.width &&
        currentStyle.transform === nextVirtualScrollThumbStyle.transform
      ) {
        return;
      }

      virtualScrollThumbStyleRef.current = nextVirtualScrollThumbStyle;
      setVirtualScrollThumbStyle(nextVirtualScrollThumbStyle);
    },
    [],
  );
  const resolveTableWidth = useCallback((viewport: HTMLDivElement) => {
    return tableRef.current?.getBoundingClientRect().width ?? viewport.scrollWidth;
  }, []);
  const resolveVirtualScrollLayoutWidth = useCallback((viewport: HTMLDivElement) => {
    return virtualScrollTrackWidthRef.current || viewport.clientWidth;
  }, []);
  const resolveRenderedVirtualScrollTrackWidth = useCallback(
    (viewport: HTMLDivElement) => {
      const trackWidth = virtualScrollTrackRef.current?.getBoundingClientRect().width ?? 0;
      if (trackWidth > 0) {
        return trackWidth;
      }

      return resolveVirtualScrollLayoutWidth(viewport);
    },
    [resolveVirtualScrollLayoutWidth],
  );
  const resolveVirtualScrollMax = useCallback(
    (viewport: HTMLDivElement) => {
      // 虚拟滚动的总距离只应由 table 标签本身宽度减去滚动条槽宽决定；
      // 之前混入 viewportLeftOffset 后，向左借位会改变最大值，导致 thumb 和内容滚动进度不一致。
      // 条件挂载后的 DOM track 会使用 CSS 宽度；若它与未挂载时保存的浮点布局宽度精度不同，
      // 可见性会在同一阈值两侧往返。是否 overflow 必须始终读取同一轮稳定的布局槽宽。
      return resolveMarkdownTableVirtualScrollMax({
        tableWidth: resolveTableWidth(viewport),
        trackWidth: resolveVirtualScrollLayoutWidth(viewport),
      });
    },
    [resolveTableWidth, resolveVirtualScrollLayoutWidth],
  );
  const commitVirtualScrollLeft = useCallback(
    (nextVirtualScrollLeft: number) => {
      const viewport = scrollViewportRef.current;
      if (!viewport) {
        virtualScrollLeftRef.current = 0;
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const clampedVirtualScrollLeft = Math.min(
        Math.max(0, nextVirtualScrollLeft),
        virtualScrollMax,
      );
      const nextViewportLeftOffset = Math.min(
        clampedVirtualScrollLeft,
        maxViewportLeftOffsetRef.current,
      );
      const nextViewportScrollLeft = clampedVirtualScrollLeft - nextViewportLeftOffset;

      virtualScrollLeftRef.current = clampedVirtualScrollLeft;
      commitViewportLeftOffset(nextViewportLeftOffset);
      viewport.scrollLeft = nextViewportScrollLeft;
    },
    [commitViewportLeftOffset, resolveVirtualScrollMax],
  );
  const syncVirtualScrollMetrics = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollThumbStyle({
        transform: "translateX(0px)",
        width: "100%",
      });
      virtualScrollLeftRef.current = 0;
      virtualScrollThumbLeftRef.current = 0;
      return;
    }

    const virtualScrollMax = resolveVirtualScrollMax(viewport);
    // 虚拟滚动条只在表格宽度超过可视槽时有意义；小表格如果也渲染 pill，
    // 会误导用户以为还有横向内容可滚。
    commitVirtualScrollbarVisible(virtualScrollMax > 1);
    const nextVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    const clampedVirtualScrollLeft = Math.min(Math.max(0, nextVirtualScrollLeft), virtualScrollMax);
    if (clampedVirtualScrollLeft !== nextVirtualScrollLeft) {
      // 状态面板收起/展开或窗口 resize 会改变槽宽，旧的虚拟滚动位置可能越过新边界。
      // 这里立即回写统一入口，避免 thumb 到边界而内容还停在旧的 DOM scrollLeft。
      commitVirtualScrollLeft(clampedVirtualScrollLeft);
      return;
    }

    virtualScrollLeftRef.current = clampedVirtualScrollLeft;
    // 已渲染 track 的实际宽度只用于 thumb 比例和位置，不能反向决定 track 是否挂载。
    const virtualScrollViewportWidth = resolveRenderedVirtualScrollTrackWidth(viewport);
    const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: clampedVirtualScrollLeft,
      scrollMax: virtualScrollMax,
      tableWidth: resolveTableWidth(viewport),
      trackWidth: virtualScrollViewportWidth,
    });
    commitVirtualScrollThumbStyle({
      transform: `translateX(${Math.round(metrics.thumbLeft)}px)`,
      width: `${Math.ceil(metrics.thumbWidth)}px`,
    });
    virtualScrollThumbLeftRef.current = metrics.thumbLeft;
  }, [
    commitVirtualScrollLeft,
    commitVirtualScrollbarVisible,
    commitVirtualScrollThumbStyle,
    resolveTableWidth,
    resolveVirtualScrollMax,
    resolveRenderedVirtualScrollTrackWidth,
  ]);
  const measureViewportMaxWidth = useCallback(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      commitCanToggleExpandedScroll(false);
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollbarSticky(false);
      maxViewportLeftOffsetRef.current = 0;
      virtualScrollTrackWidthRef.current = 0;
      commitViewportLeftOffset(0);
      return;
    }

    const frameRect = frame.getBoundingClientRect();
    let maxLeftOffset = 0;
    let maxViewportWidth = frameRect.width;
    let measuredScrollbarWidth = frameRect.width;
    let expandedMaxLeftOffset = 0;
    let expandedScrollbarWidth = frameRect.width;

    if (root) {
      const rootRect = root.getBoundingClientRect();
      // V4 的扩展边界是完整 timeline 视口而非居中的消息内容列；显式根节点
      // 通过 CSS 变量提供响应式安全边距，旧根节点继续保留原兼容规则。
      const { leftInset, rightInset } = getMarkdownTableRootInlineInsets(root);
      const measuredDistances = resolveMarkdownTableFrameDistances({
        frameWidth: frameRect.width,
        frameLeft: frameRect.left,
        frameRight: frameRect.right,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
        leftInset,
        rightInset,
      });
      expandedMaxLeftOffset = measuredDistances.maxLeftOffset;
      expandedScrollbarWidth = measuredDistances.scrollbarWidth;

      if (expandedScrollEnabledRef.current) {
        maxLeftOffset = measuredDistances.maxLeftOffset;
        maxViewportWidth = measuredDistances.maxViewportWidth;
        measuredScrollbarWidth = measuredDistances.scrollbarWidth;
      }
    }

    const tableWidth = tableRef.current?.getBoundingClientRect().width ?? 0;
    const hasFrameHorizontalOverflow = tableWidth > frameRect.width + 1;
    const hasExpandedScrollBenefit =
      expandedScrollbarWidth > frameRect.width + 1 || expandedMaxLeftOffset > 1;
    // 开关只在普通 frame 宽度下确实横向溢出，并且增强模式能提供额外可视宽度或左借位时才有意义；
    // 已开启时仍保留按钮，让用户可以收回到普通滚动范围。
    commitCanToggleExpandedScroll(
      expandedScrollEnabledRef.current || (hasFrameHorizontalOverflow && hasExpandedScrollBenefit),
    );

    maxViewportLeftOffsetRef.current = maxLeftOffset;
    virtualScrollTrackWidthRef.current = measuredScrollbarWidth;
    commitViewportMaxWidth(`${Math.ceil(maxViewportWidth)}px`);
    // 向上取整会让已挂载 track 比用于 overflow 判断的槽宽最多多 1px，
    // 子像素 overflow 恰好靠近 1px 阈值时会导致 track 每帧挂载/卸载并扰动 timeline 高度。
    commitScrollbarWidth(`${measuredScrollbarWidth}px`);
    commitVirtualScrollbarSticky(
      shouldUseMarkdownTableStickyScrollbar({
        root,
        table: tableRef.current,
      }),
    );
    if (scrollViewportRef.current) {
      commitVirtualScrollLeft(virtualScrollLeftRef.current);
    } else {
      commitViewportLeftOffset(Math.min(viewportLeftOffsetRef.current, maxLeftOffset));
    }
    syncVirtualScrollMetrics();
  }, [
    commitScrollbarWidth,
    commitCanToggleExpandedScroll,
    commitVirtualScrollLeft,
    commitVirtualScrollbarSticky,
    commitVirtualScrollbarVisible,
    commitViewportLeftOffset,
    commitViewportMaxWidth,
    syncVirtualScrollMetrics,
  ]);

  const measureEdgeShadowState = useCallback(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    const maxScrollLeft = resolveVirtualScrollMax(viewport);
    if (maxScrollLeft <= 1) {
      setNextEdgeShadowState("none");
      return;
    }

    const currentVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    // 向左借位只是把表格区域扩到左侧，不代表表格内容已经在滚动容器左边被遮住；
    // 左侧阴影只应该在真实内部 scrollLeft 产生后出现，右侧阴影继续按虚拟总进度判断。
    const hasHiddenLeft = viewport.scrollLeft > 1;
    const hasHiddenRight = currentVirtualScrollLeft < maxScrollLeft - 1;
    setNextEdgeShadowState(
      hasHiddenLeft && hasHiddenRight
        ? "both"
        : hasHiddenLeft
          ? "left"
          : hasHiddenRight
            ? "right"
            : "none",
    );
  }, [resolveVirtualScrollMax, setNextEdgeShadowState]);
  const latestMeasureEdgeShadowStateRef = useRef(measureEdgeShadowState);

  useEffect(() => {
    latestMeasureEdgeShadowStateRef.current = measureEdgeShadowState;
  });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!root || !frame || !viewport || !table) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      return;
    }

    // 表格 viewport 需要先按内容自然宽度排布，再最多扩展到当前 frame 宽度
    // 加上右侧可借用空间；直接 w-full 会丢失小表格按内容收缩的布局语义。
    let rafId: number | null = null;
    let rectWatchRafId: number | null = null;
    let rectWatchUntil = 0;
    let latestRootRect = readMarkdownTableObservedRect(root);
    let latestFrameRect = readMarkdownTableObservedRect(frame);
    const scheduleMeasure = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestRootRect = readMarkdownTableObservedRect(root);
        latestFrameRect = readMarkdownTableObservedRect(frame);
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      });
    };
    const watchRectChanges = () => {
      rectWatchRafId = null;
      const nextRootRect = readMarkdownTableObservedRect(root);
      const nextFrameRect = readMarkdownTableObservedRect(frame);
      const rectChanged =
        !isMarkdownTableObservedRectEqual(latestRootRect, nextRootRect) ||
        !isMarkdownTableObservedRectEqual(latestFrameRect, nextFrameRect);

      if (rectChanged) {
        // status panel 收起/展开可能只改变 chat root 的 left/right 位置，
        // ResizeObserver 不一定会触发；轮询 rect 签名能让左右借位和滚动槽宽跟随布局动画更新。
        latestRootRect = nextRootRect;
        latestFrameRect = nextFrameRect;
        scheduleMeasure();
      }

      if (performance.now() < rectWatchUntil) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    const scheduleMeasureAndWatchRect = () => {
      scheduleMeasure();
      rectWatchUntil = performance.now() + 800;
      if (rectWatchRafId === null) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasureAndWatchRect);
    mutationObserver?.observe(root, {
      attributeFilter: ["style"],
      attributes: true,
    });

    measureViewportMaxWidth();
    scheduleMeasureAndWatchRect();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasureAndWatchRect);
      return () => {
        window.removeEventListener("resize", scheduleMeasureAndWatchRect);
        mutationObserver?.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
      };
    }

    const stopObserving = observeResize(
      [root, frame, viewport, table],
      scheduleMeasureAndWatchRect,
    );
    window.addEventListener("resize", scheduleMeasureAndWatchRect);

    return () => {
      stopObserving();
      window.removeEventListener("resize", scheduleMeasureAndWatchRect);
      mutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
    };
  }, [commitScrollbarWidth, commitViewportMaxWidth, measureViewportMaxWidth]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    const updateViewportLayout = () => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    };
    const updateEdgeShadowState = () => {
      syncVirtualScrollMetrics();
      latestMeasureEdgeShadowStateRef.current();
    };
    const handleWheel = (event: WheelEvent) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) {
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      if (virtualScrollMax <= 1) {
        return;
      }

      event.preventDefault();
      // 向左借位和表格内容滚动原来各自维护位置，边界处会互相覆盖导致无法回滚；
      // 现在统一用虚拟 scrollLeft 映射：先消耗 leftOffset，再把剩余量交给真实 viewport.scrollLeft。
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      updateViewportLayout();
    };

    // 性能修复：p12 trace 显示流式表格 children 变化会重建 observer 并同步读布局。
    // observer 生命周期只跟 DOM 节点绑定，内容变化交给 ResizeObserver 合并到下一帧测量。
    let rafId: number | null = null;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateEdgeShadowState();
      });
    };

    updateEdgeShadowState();
    viewport.addEventListener("scroll", updateEdgeShadowState, {
      passive: true,
    });
    viewport.addEventListener("wheel", handleWheel, { passive: false });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateEdgeShadowState);
        viewport.removeEventListener("wheel", handleWheel);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const stopObserving = observeResize([viewport, table], debouncedUpdate);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      viewport.removeEventListener("scroll", updateEdgeShadowState);
      viewport.removeEventListener("wheel", handleWheel);
      stopObserving();
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    commitVirtualScrollLeft,
    measureViewportMaxWidth,
    resolveVirtualScrollMax,
    setNextEdgeShadowState,
    syncVirtualScrollMetrics,
  ]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const table = tableRef.current;
    const wrapper = virtualScrollbarWrapperRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame || !table || !wrapper || !virtualScrollbarSticky) {
      if (wrapper) wrapper.style.transform = "";
      return;
    }

    const verticalViewport = resolveMarkdownTableVerticalViewport(table, root);
    if (!verticalViewport) return;

    let rafId: number | null = null;
    let observedDock: HTMLElement | null = null;
    const updateStickyOffset = () => {
      rafId = null;
      const frameRect = frame.getBoundingClientRect();
      const viewportRect = verticalViewport.getBoundingClientRect();
      const dockHeight = readMarkdownTableDockHeight(root);
      // 离底时“回到底部”按钮位于 composer dock 上方；只扣 dock 会让长表
      // sticky 滚动条与按钮占用同一条水平带，导致按钮被宽滚动槽遮挡。
      const backToBottomClearance = readMarkdownTableBackToBottomClearance(root);
      const offset = resolveMarkdownTableStickyScrollbarOffset({
        frameTop: frameRect.top,
        frameBottom: frameRect.bottom,
        scrollbarHeight: wrapper.getBoundingClientRect().height,
        viewportBottom: viewportRect.bottom - dockHeight - backToBottomClearance,
      });
      wrapper.style.transform = offset === 0 ? "" : `translateY(${Math.round(offset)}px)`;
    };
    const scheduleStickyOffset = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(updateStickyOffset);
    };

    const stopObserving =
      typeof ResizeObserver === "undefined"
        ? undefined
        : observeResize([frame, verticalViewport], scheduleStickyOffset);
    let stopObservingDock: (() => void) | undefined;
    const syncDockObservation = () => {
      const nextDock =
        root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR) ?? null;
      // MutationObserver 也负责感知 dock 内回到底部按钮的挂载/卸载；即使 dock
      // 节点本身未变化也必须安排一次几何更新。
      if (nextDock === observedDock) {
        scheduleStickyOffset();
        return;
      }
      stopObservingDock?.();
      observedDock = nextDock;
      stopObservingDock =
        observedDock && typeof ResizeObserver !== "undefined"
          ? observeResize(observedDock, scheduleStickyOffset)
          : undefined;
      scheduleStickyOffset();
    };

    // V4 virtual row 使用 transform 定位，原生 sticky 会被 transformed ancestor
    // 限制在自然位置。改为跟随 timeline scroll 计算纵向补偿，且仍受当前表格上下边界约束。
    updateStickyOffset();
    verticalViewport.addEventListener("scroll", scheduleStickyOffset, { passive: true });
    window.addEventListener("resize", scheduleStickyOffset);
    syncDockObservation();
    // draft/空态切换会条件挂载或替换 V4 composer dock；只观察初始节点会让
    // 新 dock 的输入增高不再触发吸底重算，因此同时跟踪根节点的子树变化并重新绑定。
    const dockMutationObserver =
      typeof MutationObserver === "undefined" || !root
        ? null
        : new MutationObserver(syncDockObservation);
    if (dockMutationObserver && root) {
      dockMutationObserver.observe(root, { childList: true, subtree: true });
    }

    return () => {
      verticalViewport.removeEventListener("scroll", scheduleStickyOffset);
      window.removeEventListener("resize", scheduleStickyOffset);
      stopObserving?.();
      stopObservingDock?.();
      dockMutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      wrapper.style.transform = "";
    };
  }, [virtualScrollbarSticky, virtualScrollbarVisible]);

  const getRows = useCallback(() => readRowsFromTable(tableRef.current), []);
  const commitVirtualScrollLeftFromClientX = useCallback(
    (clientX: number, thumbDragOffset: number | null = null) => {
      const track = virtualScrollTrackRef.current;
      const viewport = scrollViewportRef.current;
      if (!track || !viewport) return;

      const trackRect = track.getBoundingClientRect();
      const trackWidth = trackRect.width;
      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
        scrollLeft: virtualScrollLeftRef.current,
        scrollMax: virtualScrollMax,
        tableWidth: resolveTableWidth(viewport),
        trackWidth,
      });
      const maxThumbLeft = Math.max(0, trackWidth - metrics.thumbWidth);
      const rawThumbLeft =
        thumbDragOffset === null
          ? clientX - trackRect.left - metrics.thumbWidth / 2
          : clientX - trackRect.left - thumbDragOffset;
      const nextThumbLeft = Math.min(maxThumbLeft, Math.max(0, rawThumbLeft));
      const nextVirtualScrollLeft =
        maxThumbLeft <= 0 ? 0 : (nextThumbLeft / maxThumbLeft) * virtualScrollMax;

      commitVirtualScrollLeft(nextVirtualScrollLeft);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveTableWidth, resolveVirtualScrollMax],
  );
  const handleVirtualScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = true;
      virtualScrollbarDragOffsetRef.current = null;
      event.currentTarget.setPointerCapture(event.pointerId);
      commitVirtualScrollLeftFromClientX(event.clientX);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = false;
      virtualScrollbarDragOffsetRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const track = virtualScrollTrackRef.current;
      if (!track) return;

      const trackRect = track.getBoundingClientRect();
      isVirtualScrollbarDraggingRef.current = true;
      // thumb 是 track 的子元素，按住 thumb 时不能冒泡到 track 的点击跳转逻辑；
      // 记录指针在 thumb 内的位置，拖动时保持这个相对偏移，避免 thumb 突然居中跳动。
      virtualScrollbarDragOffsetRef.current = Math.max(
        0,
        event.clientX - trackRect.left - virtualScrollThumbLeftRef.current,
      );
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarThumbPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      handleVirtualScrollbarPointerEnd(event);
    },
    [handleVirtualScrollbarPointerEnd],
  );
  const handleVirtualScrollbarWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) return;

      const viewport = scrollViewportRef.current;
      if (!viewport || resolveVirtualScrollMax(viewport) <= 1) return;

      event.preventDefault();
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveVirtualScrollMax],
  );

  const handleCopyMarkdown = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      onNotify(labels.copyFailed("clipboard-unavailable"), "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(sourceMarkdown ?? buildMarkdownTableText(getRows()));
      onNotify(labels.copySucceeded, "success");
    } catch (error) {
      onNotify(labels.copyFailed(error instanceof Error ? error.message : String(error)), "error");
    }
  }, [getRows, labels, onNotify, sourceMarkdown]);

  const handleDownloadCsv = useCallback(() => {
    if (
      typeof document === "undefined" ||
      typeof Blob === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      onNotify(labels.downloadFailed, "error");
      return;
    }

    const blob = new Blob([buildCsvTableText(getRows())], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "table.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [getRows, labels, onNotify]);
  const handleToggleExpandedScroll = useCallback(() => {
    const nextExpandedScrollEnabled = !expandedScrollEnabledRef.current;
    commitExpandedScrollEnabled(nextExpandedScrollEnabled);

    if (!nextExpandedScrollEnabled) {
      maxViewportLeftOffsetRef.current = 0;
      commitViewportLeftOffset(0);
      const viewport = scrollViewportRef.current;
      if (viewport) {
        // 从增强模式收回普通模式时，既有的虚拟滚动位置可能被左借位消耗；
        // 先清掉 leftOffset 再把同一个虚拟 scrollLeft 映射回真实 scrollLeft，避免表格内容跳回开头。
        viewport.scrollLeft = virtualScrollLeftRef.current;
      }
    }

    requestAnimationFrame(() => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    });
  }, [commitExpandedScrollEnabled, commitViewportLeftOffset, measureViewportMaxWidth]);

  const copyLabel = labels.copyMarkdown;
  const downloadLabel = labels.downloadCsv;
  const previewLabel = labels.openPreview;
  const scrollModeLabel = expandedScrollEnabled
    ? labels.collapseScrollMode
    : labels.expandScrollMode;
  const previewTitle = labels.previewTitle;
  const previewDescription = labels.previewDescription;
  // viewportMaxWidth 是虚拟滚动槽宽，用来计算 virtualScrollMax 和 thumb；
  // 内容层本身会 translateX 向左借位，所以需要把借出去的宽度补回右侧，避免视觉右边界跟着左移。
  const contentViewportMaxWidth =
    viewportLeftOffset > 0
      ? `calc(${viewportMaxWidth} + ${Math.ceil(viewportLeftOffset)}px)`
      : viewportMaxWidth;

  return (
    <div ref={rootRef} className="group/markdown-table relative my-0 flex min-w-0 flex-col gap-1">
      {/* 操作浮在表格右上角，悬停或键盘聚焦时出现，不再单独占一行；触屏常显。 */}
      <div
        className="absolute top-1 right-1 z-10 flex items-center gap-1 rounded-md bg-popover p-0.5 shadow-sm opacity-0 transition-opacity group-focus-within/markdown-table:opacity-100 group-hover/markdown-table:opacity-100 [@media(hover:none)]:opacity-100"
        data-markdown-table-toolbar=""
      >
        <MarkdownTableActionButton
          label={copyLabel}
          onClick={() => {
            void handleCopyMarkdown();
          }}
        >
          <CopyIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={downloadLabel} onClick={handleDownloadCsv}>
          <DownloadIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <Button
          ref={previewButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setPreviewOpen(true)}
        >
          <Maximize2Icon className="size-3.5" />
          {previewLabel}
        </Button>
        {canToggleExpandedScroll ? (
          <MarkdownTableActionButton label={scrollModeLabel} onClick={handleToggleExpandedScroll}>
            {expandedScrollEnabled ? (
              <ArrowLeftFromLine className="size-3.5" />
            ) : (
              <ArrowRightToLine className="size-3.5" />
            )}
          </MarkdownTableActionButton>
        ) : null}
      </div>
      <div
        ref={frameRef}
        className="group/markdown-table-frame relative w-full"
        data-markdown-table-frame=""
        data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
      >
        <div
          className={cn(
            "min-w-full w-max",
            viewportLeftOffset <= 0 &&
              "transition-[max-width] duration-200 ease-out motion-reduce:transition-none",
          )}
          style={{
            maxWidth: contentViewportMaxWidth,
            transform: viewportLeftOffset > 0 ? `translateX(-${viewportLeftOffset}px)` : undefined,
          }}
        >
          <div
            // 表格已有边缘阴影提示横向溢出，显示系统滚动条会在消息块底部产生额外视觉噪音；
            // 外层宽度容器按 frame 宽度 + rightDistance 计算最大宽度，滚动 viewport 只占满该容器。
            className="relative w-full overflow-hidden rounded-xl border border-border"
          >
            <div
              ref={scrollViewportRef}
              className="!scrollbar-hide w-full overflow-x-auto overflow-y-visible"
              tabIndex={0}
              role="region"
              aria-label={labels.previewTitle}
              onKeyDown={(event) => {
                if (
                  event.target !== event.currentTarget ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey
                )
                  return;
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                commitVirtualScrollLeft(
                  virtualScrollLeftRef.current + (event.key === "ArrowRight" ? 80 : -80),
                );
                latestMeasureEdgeShadowStateRef.current();
              }}
            >
              <table
                ref={tableRef}
                className={cn(
                  "w-max min-w-full border-separate border-spacing-0 text-ui-base",
                  className,
                )}
                {...props}
                data-streamdown="table"
              >
                {children}
              </table>
            </div>
            <MarkdownTableEdgeShadow side="left" state={edgeShadowState} />
            <MarkdownTableEdgeShadow side="right" state={edgeShadowState} />
          </div>
        </div>
        <div
          ref={virtualScrollbarWrapperRef}
          aria-hidden={!virtualScrollbarVisible}
          // V4 transformed virtual row 下 sticky 由 relative + translateY 模拟，
          // computed position 不能表达产品语义；显式状态供跨实现的 E2E 与可访问性诊断读取。
          data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
          data-markdown-table-virtual-scroll-visible={virtualScrollbarVisible ? "true" : "false"}
          // 滚动条槽宽必须等于 frameRect.width + rightDistance 再扣掉消息列响应式右 padding；
          // 长表格需要在纵向阅读时也能横向滚动，sticky 底部要避让 composer 和底部面板。
          // overflow 测量变化时只切换可见性，保留节点和纵向占位，避免扰动 timeline 高度。
          style={{ width: scrollbarWidth }}
          className={cn(
            "py-1 transition-[width] duration-200 ease-out motion-reduce:transition-none",
            virtualScrollbarVisible ? "visible" : "invisible",
            virtualScrollbarSticky && "relative z-20",
          )}
        >
          <div
            ref={virtualScrollTrackRef}
            aria-hidden="true"
            className="mt-1 h-3.5 w-full touch-none overflow-hidden rounded-full bg-foreground/3"
            data-markdown-table-virtual-scroll-track=""
            onPointerCancel={handleVirtualScrollbarPointerEnd}
            onPointerDown={handleVirtualScrollbarPointerDown}
            onPointerMove={handleVirtualScrollbarPointerMove}
            onPointerUp={handleVirtualScrollbarPointerEnd}
            onWheel={handleVirtualScrollbarWheel}
          >
            <div
              className="h-3 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/40"
              onPointerCancel={handleVirtualScrollbarThumbPointerEnd}
              onPointerDown={handleVirtualScrollbarThumbPointerDown}
              onPointerMove={handleVirtualScrollbarThumbPointerMove}
              onPointerUp={handleVirtualScrollbarThumbPointerEnd}
              style={virtualScrollThumbStyle}
            />
          </div>
        </div>
      </div>
      {edgeShadowState !== "none" && labels.scrollHint && (
        <span className="text-ui-caption text-foreground-subtle">{labels.scrollHint}</span>
      )}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          finalFocus={previewButtonRef}
          closeLabel={labels.closeDialog}
          className="flex max-h-[calc(100dvh-2rem)] w-max max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-hidden rounded-2xl p-4"
        >
          <DialogHeader className="pr-8">
            <DialogTitle>{previewTitle}</DialogTitle>
            <DialogDescription>{previewDescription}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="sm" onClick={() => void handleCopyMarkdown()}>
              <CopyIcon />
              {copyLabel}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDownloadCsv}>
              <DownloadIcon />
              {downloadLabel}
            </Button>
          </div>
          <div
            tabIndex={0}
            role="region"
            aria-label={labels.previewTitle}
            className="min-h-0 overflow-auto overscroll-contain rounded-xl border border-border bg-background"
          >
            <table
              className={cn(
                "w-max min-w-full border-separate border-spacing-0 text-ui-base [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background",
                className,
              )}
              {...props}
              data-streamdown="table-preview"
            >
              {children}
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MarkdownTableEdgeShadow({
  side,
  state,
}: {
  side: "left" | "right";
  state: MarkdownTableEdgeShadowState;
}) {
  const visible = state === side || state === "both";
  if (!visible) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 w-6",
        side === "left"
          ? "left-0 rounded-l-xl shadow-[inset_12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]"
          : "right-0 rounded-r-xl shadow-[inset_-12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]",
      )}
      data-markdown-table-edge-shadow={side}
    />
  );
}

function MarkdownTableActionButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

export type MarkdownTableHeaderProps = ComponentProps<"thead"> & MarkdownTableNodeProp;

export function MarkdownTableHeader({
  className,
  node: _node,
  ...props
}: MarkdownTableHeaderProps) {
  return <thead className={cn("", className)} {...props} />;
}

export type MarkdownTableBodyProps = ComponentProps<"tbody"> & MarkdownTableNodeProp;

export function MarkdownTableBody({ className, node: _node, ...props }: MarkdownTableBodyProps) {
  return <tbody className={cn("", className)} {...props} />;
}

export type MarkdownTableRowProps = ComponentProps<"tr"> & MarkdownTableNodeProp;

export function MarkdownTableRow({ className, node: _node, ...props }: MarkdownTableRowProps) {
  return (
    <tr
      className={cn("transition-colors last:[&>td]:border-b-0 hover:bg-hover/20", className)}
      {...props}
    />
  );
}

export type MarkdownTableHeadProps = ComponentProps<"th"> & MarkdownTableNodeProp;

export function MarkdownTableHead({ className, node: _node, ...props }: MarkdownTableHeadProps) {
  return (
    <th
      className={cn(
        "border-border border-b px-3 py-2 text-left font-normal text-foreground-subtlest min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}

export type MarkdownTableCellProps = ComponentProps<"td"> & MarkdownTableNodeProp;

export function MarkdownTableCell({ className, node: _node, ...props }: MarkdownTableCellProps) {
  return (
    <td
      className={cn(
        "border-border border-b px-3 py-2 text-foreground align-top min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}
