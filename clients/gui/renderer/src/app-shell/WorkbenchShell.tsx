import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cn } from "../components/lib/utils.js";
import { useReducedMotion } from "../settings/applicationPreferences.js";

/** Layout only: the host owns navigation, preferred width and persistence. */
export function WorkbenchShell({ windowInset, className, style, ...props }: ComponentProps<"div"> & { windowInset?: number }) {
  return <div {...props} className={cn("areal-workbench", className)} style={{ ...(windowInset === undefined ? {} : { "--window-inset": `${windowInset}px` }), ...style } as CSSProperties} />;
}

export function WorkspaceHeader({ className, ...props }: ComponentProps<"header">) {
  return <header {...props} className={cn("workspace-header", className)} />;
}

/** Animate the conversation's real layout; tabs, input and reading keep their owners. */
export function WorkSurface({ panelOpen, split, children }: { panelOpen: boolean; split: boolean; children: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  const previous = useRef<{ panelOpen: boolean; split: boolean; width: number } | null>(null);
  const animation = useRef<Animation | null>(null);
  const reducedMotion = useReducedMotion();
  const clearTransition = () => {
    animation.current?.cancel();
    animation.current = null;
    surface.current?.removeAttribute("data-panel-transition");
    surface.current?.parentElement?.style.removeProperty("--panel-transition-width");
  };
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const prior = previous.current;
    const from = animation.current ? element.getBoundingClientRect().width : prior?.width;
    clearTransition();
    const width = element.getBoundingClientRect().width;
    previous.current = { panelOpen, split, width };
    if (!prior || !prior.split || !split || prior.panelOpen === panelOpen || reducedMotion || from === undefined || Math.abs(from - width) < 1) return;
    const pane = element.parentElement?.querySelector<HTMLElement>(":scope > .workspace-side-panel");
    element.parentElement?.style.setProperty("--panel-transition-width", `${pane?.getBoundingClientRect().width ?? 0}px`);
    element.dataset.panelTransition = "true";
    const current = element.animate([
      { width: `${from}px`, flex: "0 0 auto" },
      { width: `${width}px`, flex: "0 0 auto" },
    ], { duration: 300, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    animation.current = current;
    current.onfinish = () => {
      if (animation.current === current) clearTransition();
    };
  }, [panelOpen, split, reducedMotion]);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (previous.current) previous.current.width = element.getBoundingClientRect().width;
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTransition(); };
  }, []);
  return <div ref={surface} className="work-surface">{children}</div>;
}

export function NavigationSidebar({ chrome, footer, rail, railOnly = false, width = 320, onWidthChange, className, children, ...props }: Omit<ComponentProps<"aside">, "width"> & {
  chrome: ReactNode;
  rail?: ReactNode;
  railOnly?: boolean;
  footer: ReactNode;
  width?: number;
  onWidthChange?: (width: number) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [maximum, setMaximum] = useState(520);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => setMaximum(Math.max(240, Math.min(520, entry.contentRect.width - 320))));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const actual = railOnly ? 52 : Math.min(maximum, Math.max(240, width));
  const resize = (next: number) => onWidthChange?.(Math.min(maximum, Math.max(240, next)));
  return <aside {...props} ref={ref} className={cn("sidebar", rail && "sidebar-with-rail", className)} style={{ "--sidebar-width": `${actual}px`, ...props.style } as CSSProperties}>
    <div className="sidebar-chrome">{!railOnly && chrome}</div>
    {rail ? <div className="sidebar-body">
      {rail}
      {!railOnly && <div className="sidebar-content">{children}{footer != null && <div className="sidebar-footer">{footer}</div>}</div>}
    </div> : <>{children}{footer != null && <div className="sidebar-footer">{footer}</div>}</>}
    {onWidthChange && !railOnly && <div
      role="separator" aria-label="侧栏宽度" aria-orientation="vertical"
      aria-valuemin={240} aria-valuemax={maximum} aria-valuenow={actual}
      tabIndex={0} className="sidebar-resize"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: actual };
      }}
      onPointerMove={event => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }}
      onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        const next = ({ ArrowLeft: actual - 16, ArrowRight: actual + 16, Home: 240, End: maximum } as Record<string, number>)[event.key];
        if (next !== undefined) { event.preventDefault(); resize(next); }
      }}
    />}
  </aside>;
}
