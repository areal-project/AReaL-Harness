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

let capturedPrepareProject: (() => Promise<unknown>) | undefined;

vi.mock("../DraftComposer.js", () => ({
  DraftComposer: (props: Record<string, unknown>) => {
    capturedPrepareProject = props.prepareProject as (() => Promise<unknown>) | undefined;
    return createElement("div", {
      "data-testid": "draft-composer",
      "data-model-ready": String(props.modelCatalogReady),
      "data-has-prepare": String(typeof props.prepareProject === "function"),
    });
  },
}));

vi.mock("../ComposerWorkspaceContext.js", () => ({
  ComposerWorkspaceContext: () => createElement("div", { "data-testid": "workspace-context" }),
}));

vi.mock("../WorktreeStarter.js", () => ({
  WorktreeStarter: () => createElement("div", { "data-testid": "worktree-starter" }),
}));

vi.mock("../CloudComposer.js", () => ({
  CloudComposer: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": "cloud-composer",
      "data-cloud-configured": String(props.cloudConfigured),
    }),
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

it("prepareProject does not pass resumeScheduling: true and respects another window's explicit stop", async () => {
  const resourceAction = vi.fn(async () => ({}));
  let latestProjects: Record<string, unknown>[] = [
    { id: "p1", root: "/tmp/LoopMe", state: { connected: false, hostState: "stopped" } },
  ];
  const renderDraft = () =>
    renderToStaticMarkup(
      createElement(
        IntlProvider,
        { locale: "zh-CN", messages: catalogs["zh-CN"] },
        createElement(ConversationWorkspace, {
          session: {
            project: latestProjects[0],
            thread: undefined,
            threadId: "",
            readOnly: false,
            projects: latestProjects,
            library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
            snapshot: { connection: { state: "ready" }, projects: latestProjects },
            resourceAction,
            retryRestoration: vi.fn(),
            pendingRestoration: vi.fn(),
            prepareBrowserDraft: { current: null },
          } as unknown as Parameters<typeof ConversationWorkspace>[0]["session"],
          services: {
            snapshot: vi.fn(async () => ({ projects: latestProjects })),
          } as unknown as Parameters<typeof ConversationWorkspace>[0]["services"],
          action: vi.fn(),
          dark: true,
          empty: true,
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

  // 场景 1：另一窗口显式停止了项目，普通发送必须拒绝且不能调用 connect 解除停止。
  latestProjects = [
    {
      id: "p1",
      root: "/tmp/LoopMe",
      scheduling: { suppressed: true },
      state: { connected: false, hostState: "stopped" },
    },
  ];
  renderDraft();
  await expect(capturedPrepareProject?.()).rejects.toThrow(/手动停止/);
  expect(resourceAction).not.toHaveBeenCalled();

  // 场景 2：空闲休眠项目的普通发送按需唤醒，不带 resumeScheduling: true。
  latestProjects = [
    { id: "p1", root: "/tmp/LoopMe", state: { connected: false, hostState: "stopped" } },
  ];
  resourceAction.mockImplementationOnce(async () => {
    latestProjects = [
      {
        id: "p1",
        root: "/tmp/LoopMe",
        core: { features: { permissionPresets: true, permissionFullAccess: false } },
        state: { connected: true, hostState: "ready" },
      },
    ];
    return {};
  });
  renderDraft();
  const readyProject = (await capturedPrepareProject?.()) as Record<string, unknown>;
  expect(resourceAction).toHaveBeenCalledWith("connect", { projectId: "p1" });
  expect(readyProject).toMatchObject({ id: "p1", state: { connected: true } });
});

it("renders the draft Local/Cloud switcher for regular projects and switches to CloudComposer in cloud mode", () => {
  const renderDraftWithEnvironment = (
    draftEnvironment: "local" | "cloud",
    projectOverride?: Record<string, unknown>,
  ) =>
    renderToStaticMarkup(
      createElement(
        IntlProvider,
        { locale: "zh-CN", messages: catalogs["zh-CN"] },
        createElement(ConversationWorkspace, {
          session: {
            project:
              projectOverride === null
                ? undefined
                : {
                    id: "p1",
                    root: "/tmp/demo",
                    state: { connected: true, hostState: "ready", threads: {} },
                    ...projectOverride,
                  },
            thread: undefined,
            threadId: "",
            readOnly: false,
            projects: [{ id: "p1", root: "/tmp/demo" }],
            library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
            snapshot: { connection: { state: "ready" }, projects: [] },
            resourceAction: vi.fn(async () => ({})),
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
            worktreeSelection: undefined,
            changeWorktreeSelection: vi.fn(),
            draftEnvironment,
            changeDraftEnvironment: vi.fn(),
            resetDraftEnvironment: vi.fn(),
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

  const localHtml = renderDraftWithEnvironment("local");
  expect(localHtml).toContain('data-testid="draft-environment-trigger"');
  expect(localHtml).toContain("本地");
  expect(localHtml).toContain('data-testid="draft-composer"');
  expect(localHtml).toContain('data-testid="worktree-starter"');
  expect(localHtml).not.toContain('data-testid="cloud-composer"');

  const cloudHtml = renderDraftWithEnvironment("cloud");
  expect(cloudHtml).toContain('data-testid="draft-environment-trigger"');
  expect(cloudHtml).toContain("云端");
  expect(cloudHtml).toContain('data-testid="cloud-composer"');
  expect(cloudHtml).not.toContain('data-testid="draft-composer"');
  expect(cloudHtml).not.toContain('data-testid="worktree-starter"');

  const projectlessHtml = renderDraftWithEnvironment("local", { projectless: true });
  expect(projectlessHtml).not.toContain('data-testid="draft-environment-trigger"');
});

it("renders Cloud-specific reconnect and Cloud settings actions with structured diagnostic details when a cold Cloud session fails to connect", () => {
  const html = renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: "zh-CN" },
      createElement(ConversationWorkspace, {
        session: {
          project: {
            id: "p1",
            root: "/workspace",
            projectless: false,
            state: { connected: false, threads: {}, queues: {}, interactions: {} },
            summaries: [
              {
                id: "cloud-t1",
                name: "Cloud · 测试下",
                cloud: { sessionId: "s1", connected: false, error: "Cloud 尚未连接" },
              },
            ],
            configurations: {},
            models: [],
          },
          thread: undefined,
          threadId: "cloud-t1",
          library: {},
          snapshot: { projects: [], connection: { state: "ready" } },
          readOnly: false,
          retryRestoration: vi.fn(),
          resourceAction: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["session"],
        services: {
          reads: { status: () => ({ connection: "ready", identity: {} }) },
          capabilities: { native: true, mutations: true },
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["services"],
        action: vi.fn(),
        dark: false,
        empty: false,
        admitting: false,
        mainPane: { current: null },
        workspacePanels: {
          view: { workspaceView: "chat" },
          removeTerminalTab: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["workspacePanels"],
        side: {
          sideChats: { pendingCreation: () => undefined, creationError: () => undefined },
          canStageSelection: false,
          canCreateSide: false,
          addSelectionToChat: vi.fn(),
          openSideSelection: vi.fn(),
          newSide: vi.fn(),
          createSide: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["side"],
        fork: { forkFromTurn: vi.fn() } as unknown as Parameters<
          typeof ConversationWorkspace
        >[0]["fork"],
        preview: { onLink: vi.fn(), rememberPanelTrigger: vi.fn() } as unknown as Parameters<
          typeof ConversationWorkspace
        >[0]["preview"],
        documents: { openFile: vi.fn(), requestReview: vi.fn() } as unknown as Parameters<
          typeof ConversationWorkspace
        >[0]["documents"],
        panelNavigation: {
          terminalOpen: false,
          setTerminalOpen: vi.fn(),
          showPanel: vi.fn(),
        } as unknown as Parameters<typeof ConversationWorkspace>[0]["panelNavigation"],
        composerWorkspace: {
          worktreeSelection: undefined,
          changeWorktreeSelection: vi.fn(),
          draftEnvironment: "local",
          changeDraftEnvironment: vi.fn(),
          resetDraftEnvironment: vi.fn(),
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
          restorationFailed: true,
          restorationError: "云端凭据验证未通过。请前往 Cloud 设置检查地址与令牌后重试。",
          viewFailure: {
            code: "CLOUD_AUTH_REJECTED",
            stage: "cloud_connect",
            diagnosticId: "deadbeef",
            detail: "HTTP 401",
            message: "云端凭据验证未通过，请检查 Cloud 设置中的地址与令牌。",
          },
          viewRefreshing: false,
          currentRestoration: { pending: false },
          isCloudSession: true,
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

  expect(html).toContain("云端凭据验证未通过");
  expect(html).toContain("HTTP 401 · #deadbeef");
  expect(html).toContain("cloud.reconnect");
  expect(html).toContain("cloud.openSettings");
  expect(html).not.toContain("项目服务暂不可用");
});
