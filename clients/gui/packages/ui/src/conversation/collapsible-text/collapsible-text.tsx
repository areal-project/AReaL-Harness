import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { observeResize } from "../../lib/observe-resize.js";

/** Presentation only: the original content and caller-owned copy actions stay intact. */
export function CollapsibleText({
  children,
  onExpandedChange,
  expandLabel = "展开全文",
  collapseLabel = "收起",
}: {
  children: ReactNode;
  onExpandedChange?: (expanded: boolean) => void;
  expandLabel?: string;
  collapseLabel?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [expandable, setExpandable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const outer = viewport.current,
      inner = content.current;
    if (!outer || !inner) return;
    const measure = () => {
      const css = getComputedStyle(outer);
      const limit =
        parseFloat(css.lineHeight) * Number(css.getPropertyValue("--long-text-preview-lines"));
      setExpandable(inner.getBoundingClientRect().height > limit + 1);
    };
    measure();
    const stopInner = observeResize(inner, measure);
    const stopOuter = observeResize(outer, measure);
    return () => {
      stopInner();
      stopOuter();
    };
  }, []);
  const change = (next: boolean) => {
    onExpandedChange?.(next);
    setExpanded(next);
    // A reader may collapse from the bottom of a tall message. Keep its
    // preview/control reachable without changing the surrounding scroll owner.
    if (!next)
      requestAnimationFrame(() => {
        if (root.current?.isConnected) root.current.scrollIntoView({ block: "nearest" });
      });
  };
  return (
    <div
      className="collapsible-text"
      ref={root}
      data-expanded={expanded}
      data-expandable={expandable}
    >
      <div
        id={id}
        className="collapsible-text-viewport"
        ref={viewport}
        onFocusCapture={() => {
          if (expandable && !expanded) change(true);
        }}
      >
        <div className="collapsible-text-content" ref={content}>
          {children}
        </div>
      </div>
      {expandable && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="collapsible-text-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => change(!expanded)}
        >
          {expanded ? collapseLabel : expandLabel}
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </Button>
      )}
    </div>
  );
}
