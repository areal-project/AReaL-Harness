import { stopConversationTurn, releaseSettledStops } from "./conversationStop.js";
import { useEffect, type RefObject } from "react";
import type { Action, Data } from "./services.js";

export function useConversationEscape({ pane, project, thread, action, enabled, outsideFallback = false, onError }: {
  pane: RefObject<HTMLElement | null>; project?: Data; thread?: Data; action: Action; enabled: boolean; outsideFallback?: boolean; onError?: (message: string) => void;
}) {
  const running = thread?.turns?.find((turn: Data) => turn.status === "inProgress");
  useEffect(() => { if (project && thread) releaseSettledStops(project.id, thread); }, [project?.id, thread]);
  useEffect(() => {
    if (!enabled || !project || !thread) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented || !pane.current?.getClientRects().length) return;
      const path = event.composedPath();
      const owned = path.includes(pane.current);
      if (!owned && (!outsideFallback || path.some(target => target instanceof Element && target.matches(".side-chat-pane")))) return;
      if (path.some(target => target instanceof Element && (target.getAttribute("role") === "dialog" || target.getAttribute("data-slot") === "dialog-content"))
        || [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"], [data-slot="select-content"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-slot="context-menu-content"]')].some(element => element.getClientRects().length)
        || pane.current.querySelector('[aria-haspopup][aria-expanded="true"], .composer-queue-edit-banner')) return;
      event.preventDefault();
      if (running) void stopConversationTurn(action, project, thread).catch(cause => onError?.(cause.message));
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [enabled, outsideFallback, project, thread, running?.id, action, pane, onError]);
}
