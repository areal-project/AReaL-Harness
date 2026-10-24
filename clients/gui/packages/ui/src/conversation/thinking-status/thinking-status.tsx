import { useEffect, useRef, useState } from "react";

/** Visible text remains readable without animation, observers or scripting. */
export function ThinkingStatus({ label }: { label?: string }) {
  const text = label?.trim() || "Thinking";
  const ref = useRef<HTMLSpanElement>(null);
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    let intersecting = false;
    const update = () => setAnimating(intersecting && document.visibilityState === "visible");
    const observer = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; update(); });
    if (ref.current) observer.observe(ref.current);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <span ref={ref} className="areal-thinking" role="status" aria-live="polite" aria-atomic="true" data-animating={animating} data-content={label?.trim() ? "summary" : "fallback"}>
    <span key={text} className="areal-thinking-message"><span>{text}</span><span className="areal-thinking-sweep" aria-hidden="true">{text}</span></span>
  </span>;
}
