import { expect, it, vi } from "vite-plus/test";
import { useSideConversations } from "./useSideConversations.js";

const mocks = vi.hoisted(() => ({ add: vi.fn(), reveal: vi.fn() }));
vi.mock("react", () => ({ useRef: (value: unknown) => ({ current: value }) }));
vi.mock("../Composer.js", () => ({ sending: new Set() }));
vi.mock("../i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.mock("../conversationSelectionReference.js", () => ({
  addConversationSelection: mocks.add,
  conversationSelectionScope: () => "child-scope",
  selectionLimitMessage: () => "limit",
}));
vi.mock("../useSideChatTabs.js", () => {
  const tab = { id: "side:child", projectId: "project", parentId: "parent", childId: "child" };
  return { useSideChatTabs: () => ({ tabs: [tab], getTab: () => tab, hasChild: () => true }) };
});

it.each([
  ["same generation", "generation", true],
  ["replaced generation", "replacement", false],
  ["missing generation", undefined, false],
])(
  "attaches a selection only to the %s after public read",
  async (_label, generation, accepted) => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    mocks.add.mockReset().mockReturnValue({ ok: true });
    mocks.reveal.mockReset();
    const project = {
      id: "project",
      core: {
        instanceId: "generation",
        serviceGeneration: "generation",
        features: { sideExecutableV2: true },
      },
      state: { connected: true },
      pending: [],
    };
    const thread = { id: "parent" };
    const action = vi.fn(async () => ({
      projects: [
        {
          id: "project",
          core: {
            instanceId: generation === undefined ? "generation" : "service-id",
            serviceGeneration: generation,
          },
          state: { threads: { child: { conversation: { origin: { sourceThreadId: "parent" } } } } },
        },
      ],
    }));
    const panels = {
      view: { panel: "side:child", workspaceView: "side" },
      revealSide: mocks.reveal,
    };
    const state = useSideConversations(
      project,
      thread,
      "parent",
      { projects: [], connection: { state: "ready" } } as never,
      action as never,
      panels as never,
      false,
      false,
      () => {},
      () => {},
    );
    state.openSideSelection({}, "quote", undefined, {
      id: "ref",
      sourceSessionId: "parent",
      sourceRowId: "row",
      contentType: "text",
      text: "quote",
    } as never);
    await vi.waitFor(() => expect(action).toHaveBeenCalled());
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(mocks.add).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(mocks.reveal).toHaveBeenCalledTimes(accepted ? 1 : 0);
  },
);
