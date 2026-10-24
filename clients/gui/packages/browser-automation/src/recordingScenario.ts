import type { BrowserCommand, BrowserRecordingAction, BrowserViewportSize } from './upstream/schema/index.js';
import type { ControlledView } from './upstream/browser/browserCommandTypes.js';
import { executeBrowserCommandOnView } from './upstream/browser/browserCommandExecutor.js';
import { executeIabPlaywrightLocator } from './upstream/browser/browserPlaywrightLocatorExecutor.js';

export class RecordingScenario {
  async executeRecordingActions(
    view: ControlledView,
    actions: BrowserRecordingAction[],
    signal: AbortSignal,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    for (const action of actions) {
      if (signal.aborted) throw abortError();
      await this.executeRecordingAction(view, action, signal, pointer);
      const delayAfterMs = "delayAfterMs" in action ? action.delayAfterMs : undefined;
      if (delayAfterMs && !(await waitForDelay(delayAfterMs, signal))) throw abortError();
    }
  }

  private async executeRecordingAction(
    view: ControlledView,
    action: BrowserRecordingAction,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    if (action.type === "wait") {
      if (!(await waitForDelay(action.durationMs, signal))) throw abortError();
      return;
    }
    if (action.type === "click" || action.type === "type" || action.type === "waitFor") {
      const locatorAction =
        action.type === "click"
          ? action.selector
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: action.doubleClick ? ("dblclick" as const) : ("click" as const),
                ...(action.button ? { button: action.button } : {}),
              }
            : undefined
          : action.type === "type"
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: "fill" as const,
                value: action.text,
              }
            : {
                name: "locator" as const,
                selector: action.selector,
                operation: "waitFor" as const,
                state: action.state ?? "visible",
              };
      if (locatorAction) {
        const result = await executeIabPlaywrightLocator(
          view,
          locatorAction,
          action.type === "waitFor" ? (action.timeoutMs ?? 3_000) : 3_000,
          signal,
        );
        if (result.kind === "cancelled") throw abortError();
        if (result.kind === "timeout")
          throw new Error(`recording action timed out: ${result.reason}`);
        return;
      }
      if (action.type !== "click") {
        throw new Error(`recording ${action.type} requires a selector`);
      }
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        throw new Error("recording click requires selector or (x,y)");
      }
      await this.executeRecordingBrowserCommand(view, {
        method: "click",
        x: action.x,
        y: action.y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.doubleClick !== undefined ? { doubleClick: action.doubleClick } : {}),
      });
      pointer.x = action.x;
      pointer.y = action.y;
      return;
    }
    if (action.type === "hover") {
      if (action.selector) {
        const point = await this.resolveRecordingSelectorPoint(view, action.selector, signal);
        await this.moveRecordingPointer(
          view,
          point.x,
          point.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else if (typeof action.x === "number" && typeof action.y === "number") {
        await this.moveRecordingPointer(
          view,
          action.x,
          action.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else {
        throw new Error("recording hover requires selector or (x,y)");
      }
      return;
    }
    if (action.type === "move") {
      await this.moveRecordingPointer(
        view,
        action.x,
        action.y,
        action.durationMs ?? 0,
        signal,
        pointer,
      );
      return;
    }
    if (action.type === "scroll") {
      await this.animateRecordingScroll(
        view,
        action.deltaX ?? 0,
        action.deltaY,
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "scrollTo") {
      const current = (await view.webContents.executeJavaScript(
        "({ x: window.scrollX, y: window.scrollY })",
      )) as { x?: unknown; y?: unknown };
      const target = action.selector
        ? await this.resolveRecordingSelectorScrollTarget(view, action.selector, signal)
        : { x: action.x ?? Number(current.x ?? 0), y: action.y ?? Number(current.y ?? 0) };
      await this.animateRecordingScroll(
        view,
        target.x - Number(current.x ?? 0),
        target.y - Number(current.y ?? 0),
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "wheel") {
      const times = action.times ?? 1;
      for (let index = 0; index < times; index += 1) {
        await this.executeRecordingBrowserCommand(view, {
          method: "scroll",
          x: action.deltaX ?? 0,
          y: action.deltaY,
        });
        if (action.intervalMs && !(await waitForDelay(action.intervalMs, signal)))
          throw abortError();
      }
      return;
    }
    if (action.type === "drag") {
      const steps = Math.max(1, action.path.length - 1);
      const intervalMs = Math.floor((action.durationMs ?? 0) / steps);
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
      });
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
        button: "left",
        clickCount: 1,
      });
      for (const point of action.path.slice(1)) {
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        });
        if (intervalMs > 0 && !(await waitForDelay(intervalMs, signal))) throw abortError();
      }
      const last = action.path.at(-1)!;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: last.x,
        y: last.y,
        button: "left",
        clickCount: 1,
      });
      pointer.x = last.x;
      pointer.y = last.y;
    }
  }

  private async executeRecordingBrowserCommand(
    view: ControlledView,
    command: BrowserCommand,
  ): Promise<void> {
    const result = await executeBrowserCommandOnView(view, command);
    if (!result.ok)
      throw new Error(result.error?.message ?? `recording action ${command.method} failed`);
  }

  private async resolveRecordingSelectorPoint(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no visible point`);
    }
    return result.value;
  }

  private async resolveRecordingSelectorScrollTarget(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no scroll target`);
    }
    return result.value;
  }

  private async moveRecordingPointer(
    view: ControlledView,
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    const startX = pointer.x;
    const startY = pointer.y;
    for (let index = 1; index <= steps; index += 1) {
      if (signal.aborted) throw abortError();
      const progress = index / steps;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + (x - startX) * progress,
        y: startY + (y - startY) * progress,
      });
      if (durationMs > 0 && index < steps && !(await waitForDelay(durationMs / steps, signal))) {
        throw abortError();
      }
    }
    pointer.x = x;
    pointer.y = y;
  }

  async installRecordingCursorOverlay(guest: ControlledView["webContents"]): Promise<void> {
    await guest.executeJavaScript(`(() => {
      const id = "__zcode_browser_recording_cursor";
      document.getElementById(id)?.remove();
      const cursor = document.createElement("div");
      cursor.id = id;
      cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity 80ms linear";
      document.documentElement.appendChild(cursor);
      const move = (event) => {
        cursor.style.left = event.clientX + "px";
        cursor.style.top = event.clientY + "px";
        cursor.style.opacity = "1";
      };
      const down = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(.72)";
      };
      const up = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(1)";
      };
      window["__zcodeBrowserRecordingCursorCleanup"]?.();
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mousedown", down, true);
      window.addEventListener("mouseup", up, true);
      window["__zcodeBrowserRecordingCursorCleanup"] = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mousedown", down, true);
        window.removeEventListener("mouseup", up, true);
        cursor.remove();
        delete window["__zcodeBrowserRecordingCursorCleanup"];
      };
    })()`);
  }

  async removeRecordingCursorOverlay(guest: ControlledView["webContents"]): Promise<void> {
    await guest
      .executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()')
      .catch(() => undefined);
  }

  private async animateRecordingScroll(
    view: ControlledView,
    deltaX: number,
    deltaY: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    for (let index = 0; index < steps; index += 1) {
      await this.executeRecordingBrowserCommand(view, {
        method: "scroll",
        x: deltaX / steps,
        y: deltaY / steps,
      });
      if (
        durationMs > 0 &&
        index + 1 < steps &&
        !(await waitForDelay(durationMs / steps, signal))
      ) {
        throw abortError();
      }
    }
  }

}
export function waitForDelay(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return "cancelled";
    if (predicate()) return "matched";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    if (!(await waitForDelay(Math.min(50, remaining), signal))) return "cancelled";
  }
}

function isBrowserPointValue(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError");
}
