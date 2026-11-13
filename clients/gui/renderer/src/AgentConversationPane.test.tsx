import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { AgentConversationPane } from "./AgentConversationPane.js";
import { PlatformReadProvider } from "./PlatformReadContext.js";
import { createHostReadServices } from "./host-services.js";
import type { Action } from "./services.js";

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.mock("./Messages.js", () => ({
  Messages: ({ thread }: { thread: { turns: { status: string }[] } }) =>
    createElement("p", null, thread.turns.at(-1)?.status),
}));

describe("agent conversation observation", () => {
  it("shows the watched child's live turn and releases the observation on close", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    effects.length = 0;
    const connection = {
      hostId: "host",
      hostGeneration: "host-gen",
      connectionId: "connection",
      gatewayGeneration: "gateway-gen",
    };
    const closed: string[] = [];
    const services = createHostReadServices(undefined, {
      origin: "areal-ui://app",
      bootstrap: async () => {
        throw new Error("unused");
      },
      transport: async () => ({
        identity: connection,
        transport: {
          close() {},
          async request(method, params, context) {
            if (method === "shell.subscribe")
              return {
                ...connection,
                subscriptionId: "shell",
                sequence: 0,
                snapshot: {
                  projects: [
                    {
                      projectId: "project",
                      workspace: "/project",
                      projectless: false,
                      state: "ready",
                      serviceGeneration: "core-gen",
                      summaries: { state: "fresh", items: [] },
                      attention: { state: "unknown" },
                    },
                  ],
                  navigation: [],
                },
              };
            if (method === "session.watch")
              return {
                ...connection,
                ...context,
                subscriptionId: "child-sub",
                sequence: 0,
                threadId: params.threadId,
                view: "conversation",
                snapshot: {
                  thread: {
                    id: "child",
                    parentThreadId: "parent",
                    turns: [{ id: "turn", status: "inProgress", items: [] }],
                  },
                  history: { snapshotId: "history", complete: true, nextCursor: null },
                },
              };
            if (method === "subscription.close") closed.push(String(params.subscriptionId));
            return { closed: true };
          },
        },
      }),
    });
    const action = vi.fn().mockResolvedValue({}) as unknown as Action;
    const render = async () => {
      const project = (await services.snapshot()).projects[0];
      return renderToStaticMarkup(
        createElement(PlatformReadProvider, {
          reads: services.reads,
          children: createElement(AgentConversationPane, {
            project,
            parentId: "parent",
            childId: "child",
            action,
            dark: false,
            onLink() {},
            onFile() {},
            onReview() {},
            onAgent() {},
          }),
        }),
      );
    };
    try {
      await vi.waitFor(async () => expect((await services.snapshot()).projects).toHaveLength(1));
      expect(await render()).toContain("正在读取子对话");
      const cleanup = effects.map((effect) => effect());
      await vi.waitFor(async () =>
        expect(Object.keys((await services.snapshot()).projects[0].state.threads)).toContain(
          "child",
        ),
      );
      await vi.waitFor(async () => expect(await render()).toContain("inProgress"));
      cleanup.forEach((release) => release?.());
      await vi.waitFor(() => expect(closed).toContain("child-sub"));
    } finally {
      page.dispatchEvent(new Event("pagehide"));
      vi.unstubAllGlobals();
    }
  });
});
