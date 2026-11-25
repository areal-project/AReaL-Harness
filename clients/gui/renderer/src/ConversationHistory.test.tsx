import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PlatformReadProvider } from "./PlatformReadContext.js";
import { useConversationHistory } from "./ConversationHistory.js";
import type { Action, PlatformReadServices } from "./services.js";

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    effects.push(effect);
  },
}));
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.mock("@areal/ui", () => ({
  DelayedVisible: ({ children }: { children: unknown }) => children,
  TitleTooltip: ({ children }: { children: unknown }) => children,
}));
vi.mock("./components/ui/button.js", () => ({ Button: () => null }));
vi.mock("./ApprovalRequest.js", () => ({ ApprovalRequest: () => null }));
vi.mock("./AskUserQuestion.js", () => ({ AskUserQuestion: () => null }));

beforeEach(() => {
  effects.length = 0;
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
});

describe("conversation history ownership", () => {
  it("waits for a cached Host conversation to become fresh before acquiring its history", async () => {
    const reads = {
      acquire: vi.fn().mockRejectedValue(new Error("Conversation unavailable")),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformReadServices;
    const thread = {
      id: "selected",
      displayHistory: { supported: true, viewGeneration: "cached", freshness: "stale" },
    };
    function View() {
      useConversationHistory("project", thread, vi.fn() as Action);
      return null;
    }
    renderToStaticMarkup(
      createElement(PlatformReadProvider, { reads, children: createElement(View) }),
    );
    const cleanups = effects.map((effect) => effect());
    await Promise.resolve();
    expect(reads.acquire).not.toHaveBeenCalled();
    cleanups.forEach((cleanup) => cleanup?.());
  });

  it("keeps the selected Host thread on Host reads", async () => {
    const reads = {
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformReadServices;
    const action = vi.fn().mockResolvedValue({});
    function View() {
      useConversationHistory(
        "project",
        { id: "selected", displayHistory: { supported: true, viewGeneration: "host" } },
        action as Action,
      );
      return null;
    }
    renderToStaticMarkup(
      createElement(PlatformReadProvider, { reads, children: createElement(View) }),
    );
    const cleanups = effects.map((effect) => effect());
    await vi.waitFor(() => expect(reads.acquire).toHaveBeenCalledWith(expect.any(String), "host"));
    expect(action).not.toHaveBeenCalled();
    cleanups.forEach((cleanup) => cleanup?.());
  });

  it("uses the auxiliary Run's Host generation for paging and release", async () => {
    const reads = {
      acquire: vi.fn().mockResolvedValue(undefined),
      loadOlder: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformReadServices;
    const thread = {
      id: "run-thread",
      displayHistory: { supported: true, viewGeneration: "run-observation" },
    };
    let history!: ReturnType<typeof useConversationHistory>;
    function RunView() {
      history = useConversationHistory("project", thread, vi.fn() as Action);
      return null;
    }
    renderToStaticMarkup(
      createElement(PlatformReadProvider, { reads, children: createElement(RunView) }),
    );
    const cleanups = effects.map((effect) => effect());
    await vi.waitFor(() =>
      expect(reads.acquire).toHaveBeenCalledWith(expect.any(String), "run-observation"),
    );
    await history.load(undefined, "older");
    expect(reads.loadOlder).toHaveBeenCalledWith("older", "run-observation");
    cleanups.forEach((cleanup) => cleanup?.());
    expect(reads.release).toHaveBeenCalledWith(expect.any(String), "run-observation");
  });
});
