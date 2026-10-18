import {
  cloneElement,
  useCallback,
  isValidElement,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";

interface ControlHintTooltipProps {
  children: ReactNode;
  title: ReactNode;
  description?: string;
  shortcut?: string;
  standalone?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: ComponentProps<typeof TooltipContent>["side"];
  align?: ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: ComponentProps<typeof TooltipContent>["sideOffset"];
  className?: string;
  triggerClassName?: string;
  triggerRef?: Ref<HTMLElement>;
}

type TriggerChildProps = {
  className?: string;
  ref?: Ref<HTMLElement>;
};

const shortcutKbdBaseClassName =
  "rounded-md h-4 inline-flex items-center bg-tooltip-tag px-1.5 text-ui-xs font-medium text-tooltip-tag-foreground";

export function ControlHintTooltip({
  children,
  title,
  description,
  shortcut,
  standalone = false,
  open,
  onOpenChange,
  side = "top",
  align = "center",
  sideOffset = 2,
  className,
  triggerClassName,
  triggerRef,
}: ControlHintTooltipProps) {
  const useAppleShortcutFont = isAppleKeyboardPlatform();
  const shortcutFontClassName = useAppleShortcutFont
    ? "tracking-normal"
    : "font-mono";
  const shortcutFontStyle = useAppleShortcutFont
    ? {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif',
      }
    : undefined;
  const assignTriggerRef = useCallback(
    (element: HTMLElement | null) => {
      if (typeof triggerRef === "function") return triggerRef(element);
      if (triggerRef) triggerRef.current = element;
    },
    [triggerRef],
  );
  const isTriggerElement = isValidElement<TriggerChildProps>(children);
  const trigger = isTriggerElement ? (
    cloneElement(children, {
      // Keep one real trigger DOM node when composing with menus and popovers.
      // Base UI render merges the child's event handlers and ref.
      className: cn("shrink-0", children.props.className, triggerClassName),
    })
  ) : (
    <span className={cn("inline-flex shrink-0", triggerClassName)}>
      {children}
    </span>
  );

  // 大会话会为每条消息动作渲染大量 ControlHintTooltip，逐个创建 Provider
  // 会把上下文树放大到消息数量级；共享 Provider 统一放在 Root。
  const tooltip = (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger render={trigger} ref={assignTriggerRef} />
      <TooltipContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          description
            ? "max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-left"
            : "max-w-[min(28rem,calc(100vw-1rem))] items-center gap-2 px-2.5 py-1 text-left has-data-[slot=kbd]:pr-1",
          className,
        )}
      >
        {description ? (
          <div className="flex w-full items-start justify-between gap-3">
            <span className="text-ui-sm font-medium leading-4 text-tooltip-foreground">
              {title}
            </span>
            {shortcut ? (
              <kbd
                data-slot="kbd"
                className={cn(
                  shortcutKbdBaseClassName,
                  shortcutFontClassName,
                  "shrink-0",
                )}
                style={shortcutFontStyle}
              >
                {shortcut}
              </kbd>
            ) : null}
          </div>
        ) : (
          // 无描述的提示过去同时受 max-w-xs 和 nowrap 约束，长中英文文案会越界裁剪。
          // 短提示继续按内容宽度展示，超过视口安全宽度时允许自然换行；显式换行用于结构化提示。
          <span className="text-ui-sm font-medium whitespace-pre-line break-words text-tooltip-foreground">
            {title}
          </span>
        )}
        {description ? (
          <span className="max-w-64 text-ui-sm/relaxed text-tooltip-foreground/80">
            {description}
          </span>
        ) : null}
        {!description && shortcut ? (
          <kbd
            data-slot="kbd"
            className={cn(
              shortcutKbdBaseClassName,
              shortcutFontClassName,
              "shrink-0",
            )}
            style={shortcutFontStyle}
          >
            {shortcut}
          </kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );

  // 少数组件需要支持脱离 Root 的 SSR/单测渲染；由封装按需补 Provider，
  // 避免业务层重新组合 Tooltip primitives，同时不让列表中的常规提示重复创建上下文。
  return standalone ? <TooltipProvider>{tooltip}</TooltipProvider> : tooltip;
}
