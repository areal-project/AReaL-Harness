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

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

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

vi.mock("../Messages.js", () => ({
  Messages: () => createElement("div", null, "Saved conversation"),
}));

vi.mock("../Composer.js", () => ({
  Composer: ({ executionBlocked }: { executionBlocked: boolean }) =>
    createElement("button", { disabled: executionBlocked }, "Send follow-up"),
}));

it.each(["draft", "saved history"] as const)("renders a disconnected project's %s", (view) => {
  const thread = view === "saved history" ? { id: "t1", persistedHistory: true } : undefined;
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
          thread,
          threadId: thread?.id ?? "",
          readOnly: !!thread,
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
        empty: !thread,
        admitting: false,
        mainPane: { current: null },
        workspacePanels: {
          view: { workspaceView: "conversation" },
          removeTerminalTab: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["workspacePanels"],
        side: {
          sideChats: { pendingCreation: vi.fn(), creationError: vi.fn() },
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["side"],
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
  if (thread) {
    expect(html).toContain("Saved conversation");
    expect(html).toContain("<button>Send follow-up</button>");
    expect(html).not.toContain("当前显示已保存的历史");
  } else {
    expect(html).toContain('data-testid="draft-composer"');
    expect(html).toContain('data-model-ready="true"');
    expect(html).toContain('data-has-prepare="true"');
    expect(html).not.toContain("正在连接项目");
  }
});

it("hides the composer project bar on non-empty threads during idle hibernation, and shows it for explicit stop or genuine faults", () => {
  const renderThread = (project: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(
        IntlProvider,
        { locale: "zh-CN", messages: catalogs["zh-CN"] },
        createElement(ConversationWorkspace, {
          session: {
            project,
            thread: { id: "t1", persistedHistory: true, turns: [{ id: "turn-1" }] },
            threadId: "t1",
            readOnly: true,
            projects: [project],
            library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
            snapshot: { connection: { state: "ready" }, projects: [project] },
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
          empty: false,
          admitting: false,
          mainPane: { current: null },
          workspacePanels: {
            view: { workspaceView: "conversation" },
            removeTerminalTab: vi.fn(),
          } as unknown as Parameters<typeof ConversationWorkspace>[0]["workspacePanels"],
          side: {
            sideChats: { pendingCreation: vi.fn(), creationError: vi.fn() },
          } as unknown as Parameters<typeof ConversationWorkspace>[0]["side"],
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
            currentRestoration: { pending: false },
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

  // 空闲休眠（stopped / stopping / 静默预热 starting）：不显示 composer-project-bar，不打扰用户。
  for (const hostState of ["stopped", "stopping", "starting"] as const) {
    const html = renderThread({
      id: "p1",
      root: "/tmp/AReaL-Harness",
      state: { connected: false, hostState, threads: {} },
    });
    expect(html).not.toContain("composer-project-bar");
    expect(html).not.toContain('data-testid="workspace-context"');
  }

  // 用户主动停止（scheduling.suppressed === true）：显示重连条。
  const suppressedHtml = renderThread({
    id: "p1",
    root: "/tmp/AReaL-Harness",
    scheduling: { suppressed: true },
    state: { connected: false, hostState: "stopped", threads: {} },
  });
  expect(suppressedHtml).toContain("composer-project-bar");
  expect(suppressedHtml).toContain('data-testid="workspace-context"');

  // 真实异常（project.error 或 hostState === "unavailable"）：显示重连条。
  const erroredHtml = renderThread({
    id: "p1",
    root: "/tmp/AReaL-Harness",
    error: "Core 异常退出",
    state: { connected: false, hostState: "stopped", threads: {} },
  });
  expect(erroredHtml).toContain("composer-project-bar");
  expect(erroredHtml).toContain('data-testid="workspace-context"');

  const unavailableHtml = renderThread({
    id: "p1",
    root: "/tmp/AReaL-Harness",
    state: { connected: false, hostState: "unavailable", threads: {} },
  });
  expect(unavailableHtml).toContain("composer-project-bar");
  expect(unavailableHtml).toContain('data-testid="workspace-context"');
});
