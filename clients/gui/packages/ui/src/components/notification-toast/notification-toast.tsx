import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { Button } from "../button/button.js";

export function NotificationToast({
  message,
  tone = "info",
  dismissLabel,
  onDismiss,
  duration = 5000,
  actions,
  requestId,
}: {
  actions?: ReactNode;
  requestId?: string;
  message: string;
  tone?: "info" | "success" | "warning" | "error";
  dismissLabel: string;
  onDismiss: () => void;
  duration?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [exiting, setExiting] = useState(false);
  const paused = hovered || focused || exiting;
  const remaining = useRef(duration);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const startExit = () => {
    if (exiting) return;
    const reduced =
      typeof window !== "undefined" &&
      (document.documentElement.dataset.reducedMotion === "true" ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    if (reduced) {
      dismiss.current();
      return;
    }
    setExiting(true);
  };
  useEffect(() => {
    if (paused) return;
    const started = performance.now();
    const timer = setTimeout(() => startExit(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [paused]);
  useEffect(() => {
    if (!exiting) return;
    // 兜底：无动画环境（如 jsdom）不会触发 animationend，确保仍按时卸载。
    const fallback = setTimeout(() => dismiss.current(), 180);
    return () => clearTimeout(fallback);
  }, [exiting]);
  const Icon =
    tone === "error"
      ? CircleAlert
      : tone === "warning"
        ? TriangleAlert
        : tone === "success"
          ? CircleCheck
          : Info;
  return (
    <div
      className="areal-notification-toast"
      data-tone={tone}
      data-exiting={exiting ? "true" : undefined}
      data-recovery-request-id={requestId}
      role={tone === "error" ? "alert" : "status"}
      aria-atomic="true"
      onAnimationEnd={(event) => {
        if (exiting && event.target === event.currentTarget) dismiss.current();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Icon className="areal-toast-icon" aria-hidden="true" />
      <span>{message}</span>
      {actions && <div className="areal-toast-actions">{actions}</div>}
      <Button variant="ghost" size="icon-xs" aria-label={dismissLabel} onClick={startExit}>
        <X size={12} aria-hidden="true" />
      </Button>
    </div>
  );
}
