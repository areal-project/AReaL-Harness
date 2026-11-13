import { afterEach, expect, it, vi } from "vite-plus/test";
import { useConversationEscape } from "./useConversationEscape.js";
import type { Action } from "./services.js";

vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));

it.each([true, false])("routes Escape within a Side pane with running=%s", async (running) => {
  class ElementFixture {
    constructor(private side = false) {}
    matches(selector: string) {
      return this.side && selector === ".side-chat-pane";
    }
    getAttribute() {
      return null;
    }
    getClientRects() {
      return [1];
    }
    querySelector() {
      return null;
    }
  }
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  vi.stubGlobal("Element", ElementFixture);
  vi.stubGlobal("document", { querySelectorAll: () => [] });
  const main = new ElementFixture();
  const side = new ElementFixture(true);
  const action = vi.fn(async () => ({})) as unknown as Action;
  const project = { id: "project", pending: [] };
  for (const [pane, thread, outsideFallback] of [
    [main, { id: "main", turns: [{ id: "main-turn", status: "inProgress" }] }, true],
    [
      side,
      { id: "child", turns: running ? [{ id: "child-turn", status: "inProgress" }] : [] },
      false,
    ],
  ] as const) {
    useConversationEscape({
      pane: { current: pane as unknown as HTMLElement },
      project,
      thread,
      action,
      enabled: true,
      outsideFallback,
    });
  }
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, {
    key: "Escape",
    isComposing: false,
    keyCode: 0,
    composedPath: () => [side],
  });
  page.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(action).toHaveBeenCalledTimes(running ? 1 : 0);
  if (running)
    expect(action).toHaveBeenCalledWith(
      "stop",
      expect.objectContaining({ threadId: "child", turnId: "child-turn" }),
    );
});

afterEach(() => vi.unstubAllGlobals());
