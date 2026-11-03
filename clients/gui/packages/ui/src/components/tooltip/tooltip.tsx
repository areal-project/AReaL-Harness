"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "../../lib/utils.js";

// 沿用 Base UI 的分组节奏：首个提示悬停约 600ms 才出现，之后 400ms 内移到相邻触发器立即切换。
// 0 延迟会让鼠标划过工具栏时接连弹出提示。
const TooltipProvider = TooltipPrimitive.Provider;

type CloseTooltip = () => void;
type ScrollTarget = Pick<Document, "addEventListener" | "removeEventListener">;

// 滚动后指针下已是别的内容，悬停打开的提示会指向错位的触发器；键盘聚焦打开的保留。
export function createHoverTooltipTracker(target: () => ScrollTarget | undefined) {
  const open = new Set<CloseTooltip>();
  let listening: ScrollTarget | undefined;
  const dismissAll = () => {
    const closing = [...open];
    open.clear();
    stop();
    for (const close of closing) close();
  };
  const stop = () => {
    listening?.removeEventListener("scroll", dismissAll, { capture: true });
    listening = undefined;
  };
  return {
    opened(close: CloseTooltip) {
      open.add(close);
      if (listening) return;
      listening = target();
      listening?.addEventListener("scroll", dismissAll, { capture: true, passive: true });
    },
    closed(close: CloseTooltip) {
      open.delete(close);
      if (open.size === 0) stop();
    },
    dismissAll,
  };
}

const hoverTooltips = createHoverTooltipTracker(() =>
  typeof document === "undefined" ? undefined : document,
);

function Tooltip<Payload>({
  actionsRef,
  onOpenChange,
  ...props
}: TooltipPrimitive.Root.Props<Payload>) {
  const localActionsRef = React.useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actions = actionsRef ?? localActionsRef;
  const [close] = React.useState(() => () => actions.current?.close());
  React.useEffect(() => () => hoverTooltips.closed(close), [close]);
  return (
    <TooltipPrimitive.Root
      {...props}
      actionsRef={actions}
      onOpenChange={(open, details) => {
        if (open && details.reason === "trigger-hover") hoverTooltips.opened(close);
        else hoverTooltips.closed(close);
        onOpenChange?.(open, details);
      }}
    />
  );
}
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  side = "top",
  align = "center",
  anchor,
  sideOffset = 0,
  children,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Popup>, "className"> & {
  className?: string;
} & Pick<
    React.ComponentProps<typeof TooltipPrimitive.Positioner>,
    "side" | "align" | "sideOffset" | "anchor"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        anchor={anchor}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="z-(--layer-tooltip)"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          role="tooltip"
          className={cn(
            "ui-popup inline-flex w-fit max-w-[min(20rem,var(--available-width))] items-center gap-1.5 rounded-overlay border border-border bg-tooltip px-3 py-1.5 text-ui-sm text-tooltip-foreground shadow-overlay has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:rounded-sm",
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
/**
 * 代替浏览器原生 title：延迟、外观和位置与应用提示一致。title 为空时原样返回元素。
 * 元素本身成为触发器，不额外包一层 DOM。文字 title 同时写入 aria-description，
 * 保留原生 title 给辅助技术的说明；与 aria-label 相同时不重复。
 */
function TitleTooltip({
  title,
  children,
}: {
  title?: React.ReactNode;
  children: React.ReactElement<{ "aria-label"?: string }>;
}) {
  if (title === undefined || title === null || title === false || title === "") return children;
  const description =
    typeof title === "string" && children.props["aria-label"] !== title ? title : undefined;
  return (
    <Tooltip>
      <TooltipTrigger render={children} aria-description={description} />
      <TooltipContent
        sideOffset={2}
        className="max-w-[min(28rem,calc(100vw-1rem))] px-2.5 py-1 text-left"
      >
        <span className="text-ui-sm font-medium whitespace-pre-line break-words text-tooltip-foreground">
          {title}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, TitleTooltip };
