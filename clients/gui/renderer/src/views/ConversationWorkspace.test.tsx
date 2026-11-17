import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

vi.hoisted(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});

import { IntlProvider } from "react-intl";
import { catalogs } from "../i18n/messages.js";
import { ConversationWorkspace } from "./ConversationWorkspace.js";

vi.mock("../DraftComposer.js", () => ({
  DraftComposer: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "draft-composer",
      "data-model-ready": String(props.modelCatalogReady),
      "data-has-prepare": String(typeof props.prepareProject === "function"),
    }),
}));

vi.mock("../ComposerWorkspaceContext.js", () => ({
  ComposerWorkspaceContext: () => createElement("div", { "data-testid": "workspace-context" }),
}));

vi.mock("../WorktreeStarter.js", () => ({
  WorktreeStarter: () => createElement("div", { "data-testid": "worktree-starter" }),
}));

vi.mock("../pendingMessage.js", () => ({
  usePendingMessage: () => undefined,
}));

it("renders draft composer immediately for a disconnected project without threadId", () => {
  const html = renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: "zh-CN", messages: catalogs["zh-CN"] },
      createElement(ConversationWorkspace, {
        session: {
          project: {
            id: "p1",
            root: "/tmp/demo",
            models: [{ providerId: "fixture", modelId: "saved-model" }],
            state: { connected: false, threads: {} },
          },
          thread: undefined,
          threadId: "",
          projects: [{ id: "p1", root: "/tmp/demo" }],
          library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
          snapshot: { connection: { state: "ready" }, projects: [] },
          resourceAction: vi.fn(),
          retryRestoration: vi.fn(),
          pendingRestoration: vi.fn(),
          prepareBrowserDraft: { current: null },
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["session"],
        services: { snapshot: vi.fn() } as unknown as Parameters<
          typeof ConversationWorkspace
        >[0]["services"],
        action: vi.fn(),
        dark: true,
        empty: true,
        admitting: false,
        mainPane: { current: null },
        workspacePanels: {
          view: { workspaceView: "conversation" },
          removeTerminalTab: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["workspacePanels"],
        mcpWorkspace: {} as Parameters<typeof ConversationWorkspace>[0]["mcpWorkspace"],
        side: {} as Parameters<typeof ConversationWorkspace>[0]["side"],
        fork: {} as Parameters<typeof ConversationWorkspace>[0]["fork"],
        preview: { onLink: vi.fn() } as unknown as Parameters<
          typeof ConversationWorkspace
        >[0]["preview"],
        documents: {} as Parameters<typeof ConversationWorkspace>[0]["documents"],
        panelNavigation: {
          terminalOpen: false,
          setTerminalOpen: vi.fn(),
          showPanel: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["panelNavigation"],
        composerWorkspace: {
          appEntries: [],
          worktreeSelection: undefined,
          changeWorktreeSelection: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["composerWorkspace"],
        annotation: { openImageAnnotation: vi.fn() } as unknown as Parameters<
          typeof ConversationWorkspace
        >[0]["annotation"],
        surfaces: {
          setWorktreeSettingsTarget: vi.fn(),
          setSettingsTab: vi.fn(),
          setSettingsOpen: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["surfaces"],
        tasks: {} as Parameters<typeof ConversationWorkspace>[0]["tasks"],
        startup: {
          restorationFailed: false,
          restorationError: "",
          viewFailure: undefined,
          viewRefreshing: false,
          currentRestoration: { pending: true },
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["startup"],
        navigationCommands: {
          newTask: vi.fn(),
          choose: vi.fn(),
          leaveProject: vi.fn(),
          open: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["navigationCommands"],
        setError: vi.fn(),
        conversationReferences: [],
        readTurnReview: vi.fn(),
        pending: false,
      }),
    ),
  );
  expect(html).toContain('data-testid="draft-composer"');
  expect(html).toContain('data-model-ready="true"');
  expect(html).toContain('data-has-prepare="true"');
  expect(html).not.toContain("正在连接项目");
});
