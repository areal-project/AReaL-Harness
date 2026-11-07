import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PlatformReadProvider } from "./PlatformReadContext.js";
import { useConversationHistory } from "./ConversationHistory.js";
import { TaskRunConversations } from "./TaskRunConversations.js";
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

  it("routes auxiliary Run history through its original Workbench owner", async () => {
    const reads = {
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformReadServices;
    const action = vi.fn().mockResolvedValue({ supported: true, viewGeneration: "desktop" });
    const thread = {
      id: "run-thread",
      turns: [],
      displayHistory: { supported: true, viewGeneration: "desktop", owner: "workbench" },
    };
    const project = {
      id: "project",
      core: { instanceId: "core", connectionGeneration: "gen" },
      state: { connected: true, threads: { "run-thread": thread }, interactions: {} },
    };
    let history!: ReturnType<typeof useConversationHistory>;
    function RunView() {
      history = useConversationHistory("project", thread, action as Action);
      return null;
    }
    renderToStaticMarkup(
      createElement(PlatformReadProvider, {
        reads,
        children: createElement(TaskRunConversations, {
          project,
          task: { id: "task", runs: [{ id: "run", threadId: "run-thread" }] },
          action: action as Action,
          disabled: false,
          renderConversation: () => createElement(RunView),
        }),
      }),
    );
    const cleanups = effects.map((effect) => effect());
    await vi.waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        "history",
        expect.objectContaining({
          projectId: "project",
          threadId: "run-thread",
          operation: "acquire",
        }),
      ),
    );
    expect(reads.acquire).not.toHaveBeenCalled();
    await history.load(undefined, "older");
    expect(action).toHaveBeenCalledWith(
      "history",
      expect.objectContaining({
        projectId: "project",
        threadId: "run-thread",
        operation: "loadOlder",
        pageId: "older",
      }),
    );
    cleanups.forEach((cleanup) => cleanup?.());
    expect(action).toHaveBeenCalledWith(
      "history",
      expect.objectContaining({
        projectId: "project",
        threadId: "run-thread",
        operation: "release",
      }),
    );
  });
});
