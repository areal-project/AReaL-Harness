import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type PopoverSidebarProps = {
  /** 侧栏是否处于收起态；仅收起态启用左缘悬停浮出。 */
  collapsed: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  label?: string;
  children?: ReactNode;
  className?: string;
};

/** 折叠侧栏悬停浮层容器：收起后鼠标移入左缘或键盘聚焦时以浮层滑出，不挤压主阅读区。 */
export function PopoverSidebar({
  collapsed,
  open: controlledOpen,
  onOpenChange,
  label = "浮动导航侧栏",
  children,
  className,
}: PopoverSidebarProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = collapsed ? (controlledOpen ?? localOpen) : false;

  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!collapsed) return <>{children}</>;

  const scheduleClose = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 180);
  };
  const cancelClose = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
  };

  return (
    <div
      data-slot="popover-sidebar"
      data-open={open || undefined}
      className={cn("areal-popover-sidebar-host", className)}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
      onFocusCapture={cancelClose}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <div className="areal-popover-sidebar-edge" aria-hidden="true" />
      <aside
        aria-label={label}
        aria-hidden={!open}
        className="areal-popover-sidebar-panel"
        data-popover="true"
        data-open={open || undefined}
      >
        {children}
      </aside>
    </div>
  );
}
