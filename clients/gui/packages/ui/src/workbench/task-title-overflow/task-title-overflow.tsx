import { observeResize } from "../../lib/observe-resize.js";
import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
} from "react";
import { TitleTooltip } from "../../components/tooltip/tooltip.js";
import { cn } from "../../lib/utils.js";

const overflowFadeClassName =
  "[mask-image:linear-gradient(to_right,black_calc(100%_-_var(--spacing-control-sm)),transparent)] [-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_var(--spacing-control-sm)),transparent)]";

type TaskTitleOverflowTextProps = ComponentPropsWithoutRef<"p"> & {
  as?: "p" | "span";
  /** 已不再滚动，保留参数以兼容旧调用。 */
  reducedMotion?: boolean;
};

/** 长标题截断并在右侧渐隐，悬停时用应用提示显示全名；不再走马灯，避免扫视列表时文字在动。 */
export function TaskTitleOverflowText({
  as = "p",
  reducedMotion: _reducedMotion,
  children,
  className,
  title,
  ...props
}: TaskTitleOverflowTextProps) {
  const Component = as as ElementType;
  const textRef = useRef<HTMLElement | null>(null);
  const originalTextRef = useRef<HTMLSpanElement | null>(null);
  const [isOverflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const textElement = textRef.current;
    const originalTextElement = originalTextRef.current;
    if (!textElement || !originalTextElement) return;
    const updateOverflow = () =>
      setOverflowing(originalTextElement.scrollWidth > textElement.clientWidth);
    updateOverflow();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => window.removeEventListener("resize", updateOverflow);
    }
    return observeResize([textElement, originalTextElement], updateOverflow);
  }, [children]);

  // clip 而不是 hidden：hidden 仍是滚动容器，点击或聚焦会把标题开头横向滚出视野。
  return (
    <TitleTooltip title={isOverflowing ? title : undefined}>
      <Component
        ref={textRef}
        className={cn(
          "min-w-0 flex-1 overflow-clip whitespace-nowrap",
          isOverflowing && overflowFadeClassName,
          className,
        )}
        {...props}
      >
        <span ref={originalTextRef} data-task-title-copy="original">
          {children}
        </span>
      </Component>
    </TitleTooltip>
  );
}
