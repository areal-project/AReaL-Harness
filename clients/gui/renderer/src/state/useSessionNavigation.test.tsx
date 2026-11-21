import { createElement, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { PlatformServices, Snapshot } from "../services.js";
import { useSessionNavigation } from "./useSessionNavigation.js";

const seed = vi.hoisted(() => ({
  snapshot: undefined as Snapshot | undefined,
  selectedProject: undefined as string | undefined,
  stateIndex: 0,
  restoration: undefined as ReturnType<typeof useSessionNavigation>["restoration"],
  hostGeneration: undefined as string | undefined,
  connectionId: undefined as string | undefined,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const selected = seed.stateIndex++ === 2 && seed.selectedProject;
      const [value, setValue] = react.useState(
        selected ||
          (seed.snapshot && initial && typeof initial === "object" && "projects" in initial
            ? seed.snapshot
            : initial),
      );
      return seed.stateIndex === 2
        ? [
            value,
            (next: SetStateAction<typeof seed.restoration>) => {
              seed.restoration = typeof next === "function" ? next(seed.restoration) : next;
              setValue(next);
            },
          ]
        : [value, setValue];
    },
  };
});
afterEach(() => {
  seed.snapshot = undefined;
  seed.selectedProject = undefined;
  seed.restoration = undefined;
  seed.hostGeneration = undefined;
  seed.connectionId = undefined;
  vi.unstubAllGlobals();
});

function fixture(
  native: boolean,
  connect: (resume: boolean) => Promise<void>,
  recoveryOnly = false,
  persistedHistory = false,
  selectedThreadId = owner.threadId,
) {
  seed.snapshot ??= {
    connection: { state: "ready" },
    projects: [{ id: owner.projectId, root: "/fixture", state: { connected: false, threads: {} } }],
  };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) =>
      key === "areal-gui:project"
        ? owner.projectId
        : key === `areal-gui:thread:${owner.projectId}`
          ? selectedThreadId
          : null,
    setItem: () => {},
  });
  const events: string[] = [];
  const command = vi.fn(async (name: string, params: Record<string, unknown>) => {
    events.push(name);
    if (name === "connectService") return { value: null };
    if (name === "connect") await connect(params.resumeScheduling === true);
    return {
      value: {
        projects: [],
        library: {
          projects: {},
          threads: {},
          projectOrder: [],
          sidebarThreadOrder: [],
          sidebarRevision: 0,
          settings: {},
          sections: [],
        },
        connection: { state: "ready" },
      },
    };
  });
  const selectSession = vi.fn(
    async (_target: { projectId: string; threadId: string; persisted?: boolean } | null) => {
      events.push("read");
    },
  );
  const services = {
    capabilities: { native, mutations: true },
    workbench: { call: command },
    reads: {
      selectSession,
      status: () => ({
        connection: "ready",
        identity: {
          persistedHistory,
          hostId: "host",
          hostGeneration: seed.hostGeneration,
          connectionId: seed.connectionId,
        },
      }),
    },
  } as unknown as PlatformServices;
  const recoverPersistedHistory = vi.fn(
    async (_target: { projectId: string; threadId: string } | null) => {},
  );
  if (recoveryOnly) {
    services.reads = undefined;
    services.recoverPersistedHistory = recoverPersistedHistory;
  }
  let navigation: ReturnType<typeof useSessionNavigation> | undefined;
  function Harness() {
    navigation = useSessionNavigation(services, vi.fn());
    return null;
  }
  seed.stateIndex = 0;
  renderToStaticMarkup(createElement(Harness));
  if (!navigation) throw Error("Navigation not mounted");
  return { navigation, command, selectSession, recoverPersistedHistory, events, services };
}
const owner = { projectId: "saved-project", threadId: "old-thread", connectionGeneration: 0 };

it("opens a fresh draft in a stopped project without an empty Thread target", async () => {
  const connect = vi.fn(async () => {});
  const f = fixture(true, connect, false, true);
  await f.navigation.selectConversation(owner.projectId, "");
  expect(f.command).toHaveBeenCalledExactlyOnceWith("connect", { projectId: owner.projectId });
  expect(connect).toHaveBeenCalledTimes(1);
  expect(f.selectSession).toHaveBeenCalledExactlyOnceWith(null);
});

it("browser reads stopped project history without activating execution", async () => {
  const f = fixture(
    false,
    async () => {
      throw Error("reading history must not activate Core");
    },
    false,
    true,
  );
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events).toEqual(["read"]);
  expect(f.selectSession).toHaveBeenCalledExactlyOnceWith({
    projectId: owner.projectId,
    threadId: owner.threadId,
    persisted: true,
  });
});

it("does not reopen a persisted reader while its execution changes generation", async () => {
  seed.selectedProject = owner.projectId;
  seed.snapshot = {
    connection: { state: "ready" },
    projects: [
      {
        id: owner.projectId,
        root: "/fixture",
        core: { connectionGeneration: "starting-generation" },
        state: {
          connected: false,
          threads: { [owner.threadId]: { id: owner.threadId, persistedHistory: true } },
        },
      },
    ],
  };
  const f = fixture(true, async () => {}, false, true);
  await f.navigation.restoreConversation(owner, "connect");
  f.navigation.synchronizeRestoration();
  await Promise.resolve();
  expect(f.selectSession).toHaveBeenCalledTimes(1);
  expect(f.command).not.toHaveBeenCalled();
});

it("uses the live reader when persisted history is locked", async () => {
  const f = fixture(true, async () => {}, false, true);
  f.selectSession.mockRejectedValueOnce(
    Object.assign(Error("history locked"), { code: "PERSISTED_HISTORY_UNAVAILABLE" }),
  );
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events.filter((event) => event !== "library")).toEqual(["connect", "read"]);
  expect(f.selectSession).toHaveBeenLastCalledWith({
    projectId: owner.projectId,
    threadId: owner.threadId,
  });
});

it("refreshes the Host directory after cold activation before opening an empty conversation", async () => {
  const f = fixture(true, async () => {}, false, true);
  let directoryReady = false;
  const refreshProjects = vi.fn(async () => {
    f.events.push("refresh");
    directoryReady = true;
  });
  Object.assign(f.services.reads!, { refreshProjects });
  f.selectSession.mockImplementation(async (target) => {
    f.events.push(target?.persisted ? "persisted" : "live");
    if (target?.persisted)
      throw Object.assign(new Error("No saved messages"), {
        code: "PERSISTED_HISTORY_UNAVAILABLE",
      });
    if (!directoryReady) throw new Error("Project Core unavailable");
  });

  await f.navigation.selectConversation(owner.projectId, owner.threadId);

  expect(f.events.filter((event) => event !== "library")).toEqual([
    "persisted",
    "connect",
    "refresh",
    "live",
  ]);
  expect(seed.restoration).toMatchObject({ pending: false, error: "" });
});

it("keeps persisted history read-only when execution activation is unavailable", async () => {
  const f = fixture(
    false,
    async () => {
      throw Error("unexpected activation");
    },
    false,
    true,
  );
  f.services.capabilities!.mutations = false;
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.selectSession).toHaveBeenCalledExactlyOnceWith({
    projectId: owner.projectId,
    threadId: owner.threadId,
    persisted: true,
  });
});

it("does not reopen an old conversation after its delayed connection completes", async () => {
  let release!: () => void;
  const connected = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(true, () => connected);
  const first = f.navigation.selectConversation(owner.projectId, owner.threadId);
  await vi.waitFor(() => expect(f.events).toEqual(["connect"]));
  const second = f.navigation.selectConversation(owner.projectId, "new-thread");
  try {
    await vi.waitFor(() => expect(f.events).toEqual(["connect", "connect"]));
  } finally {
    release();
    await Promise.all([first, second]);
  }
  expect(f.selectSession).not.toHaveBeenCalledWith({
    projectId: owner.projectId,
    threadId: owner.threadId,
  });
  expect(f.selectSession).toHaveBeenLastCalledWith({
    projectId: owner.projectId,
    threadId: "new-thread",
  });
});

it("connects a stopped execution when its logical project is already connected", async () => {
  seed.snapshot = {
    connection: { state: "ready" },
    projects: [
      {
        id: owner.projectId,
        root: "/main",
        core: { connectionGeneration: "main-generation" },
        state: { connected: true, threads: {} },
        summaries: [
          {
            id: owner.threadId,
            executionRoot: "/worktree",
            executionConnected: false,
            executionCore: { connectionGeneration: "worktree-generation" },
          },
        ],
      },
    ],
  };
  const f = fixture(true, async () => {});
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events.filter((event) => event !== "library")).toEqual(["connect", "read"]);
});

it.each([true, false])(
  "connects a stopped saved project before Host history on native=%s",
  async (native) => {
    let release!: () => void;
    const connected = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(native, () => connected);
    const opening = f.navigation.restoreConversation(owner, "connect");
    try {
      await vi.waitFor(() =>
        expect(f.command).toHaveBeenCalledWith("connect", {
          projectId: owner.projectId,
          threadId: owner.threadId,
        }),
      );
      expect(f.selectSession).not.toHaveBeenCalled();
    } finally {
      release();
      await opening;
    }
    expect(f.events).toEqual(["connect", "read"]);
    expect(f.selectSession).toHaveBeenCalledWith({
      projectId: owner.projectId,
      threadId: owner.threadId,
    });
  },
);

it("keeps a user-stopped project blocked until explicit resume", async () => {
  const f = fixture(true, async (resume) => {
    if (!resume) throw Object.assign(Error("stopped"), { code: "CORE_STOPPED" });
  });
  await f.navigation.restoreConversation(owner, "connect");
  expect(f.selectSession).not.toHaveBeenCalled();
  expect(f.command).toHaveBeenCalledWith("connect", {
    projectId: owner.projectId,
    threadId: owner.threadId,
  });
  await f.navigation.restoreConversation(owner, "connect", { resumeScheduling: true });
  expect(f.command).toHaveBeenLastCalledWith("connect", {
    projectId: owner.projectId,
    threadId: owner.threadId,
    resumeScheduling: true,
  });
  expect(f.selectSession).toHaveBeenCalledTimes(1);
});

it("browser reads persisted history without probing a blocked execution owner", async () => {
  const f = fixture(
    false,
    async () => {
      throw Object.assign(Error("old owner"), { code: "migrationBlocked" });
    },
    false,
    true,
  );
  await f.navigation.restoreConversation(owner, "connect");
  expect(f.selectSession).toHaveBeenCalledWith({
    projectId: owner.projectId,
    threadId: owner.threadId,
    persisted: true,
  });
  expect(f.command).not.toHaveBeenCalled();
});

it.each([
  { code: "COMMAND_FAILED" },
  { code: "migrationBlocked", submissionUnknown: true },
  { code: "migrationBlocked", outcome: { kind: "admitted" } },
  { code: "migrationBlocked", outcome: { kind: "unconfirmed" } },
])("does not treat uncertain or unrelated errors as migration blocks: %o", async (failure) => {
  const f = fixture(true, async () => {
    throw Object.assign(Error("connect failed"), failure);
  });
  await f.navigation.restoreConversation(owner, "connect");
  expect(f.selectSession).not.toHaveBeenCalled();
});

it("browser does not activate execution when persisted history is available", async () => {
  const f = fixture(
    false,
    async () => {
      throw Object.assign(Error("activation result unknown"), {
        code: "migrationBlocked",
        submissionUnknown: true,
        commandId: "original",
      });
    },
    false,
    true,
  );
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.selectSession).toHaveBeenCalledExactlyOnceWith({
    projectId: owner.projectId,
    threadId: owner.threadId,
    persisted: true,
  });
});

it("opens history on an already connected project without launching it again", async () => {
  const f = fixture(true, async () => {
    throw Error("unexpected connect");
  });
  await f.navigation.restoreConversation(owner, "open");
  expect(f.command).not.toHaveBeenCalled();
  expect(f.selectSession).toHaveBeenCalledTimes(1);
});

it("default desktop uses persisted recovery only after a definite migration refusal", async () => {
  const f = fixture(
    true,
    async () => {
      throw Object.assign(Error("old owner"), { code: "migrationBlocked" });
    },
    true,
  );
  await f.navigation.restoreConversation(owner, "connect");
  expect(f.command).toHaveBeenCalledWith("connect", {
    projectId: owner.projectId,
    threadId: owner.threadId,
  });
  expect(f.recoverPersistedHistory).toHaveBeenCalledWith({
    projectId: owner.projectId,
    threadId: owner.threadId,
  });
  expect(f.selectSession).not.toHaveBeenCalled();
});

it.each([
  { code: "COMMAND_FAILED" },
  { code: "migrationBlocked", submissionUnknown: true },
  { code: "MIGRATION_PENDING", outcome: { kind: "unconfirmed" } },
])("default desktop preserves rejected recovery boundary: %o", async (failure) => {
  const f = fixture(
    true,
    async () => {
      throw Object.assign(Error("blocked"), failure);
    },
    true,
  );
  await f.navigation.restoreConversation(owner, "connect");
  expect(f.recoverPersistedHistory.mock.calls.every(([target]) => target === null)).toBe(true);
});

it("default desktop keeps normal opening and explicit scheduling resume on desktop", async () => {
  const f = fixture(true, async () => {}, true);
  await f.navigation.restoreConversation(owner, "open");
  expect(f.command).toHaveBeenCalledWith("open", {
    projectId: owner.projectId,
    threadId: owner.threadId,
  });
  await f.navigation.restoreConversation(owner, "connect", { resumeScheduling: true });
  expect(f.command).toHaveBeenLastCalledWith("connect", {
    projectId: owner.projectId,
    threadId: owner.threadId,
    resumeScheduling: true,
  });
  expect(f.recoverPersistedHistory.mock.calls.every(([target]) => target === null)).toBe(true);
});

it.each([true, false])("restores the backend before Host reads on native=%s", async (native) => {
  const f = fixture(native, async () => {});
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  f.events.length = 0;
  await f.navigation.restoreConversation(owner, "connect", { connectService: true });
  expect(f.events.filter((name) => name !== "library")).toEqual([
    "connectService",
    "connect",
    "read",
  ]);
});

it("desktop restores execution after displaying persisted history without submitting input", async () => {
  const f = fixture(true, async () => {}, false, true);
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events).toEqual(["read", "connect", "read"]);
  expect(f.selectSession).toHaveBeenNthCalledWith(1, {
    projectId: owner.projectId,
    threadId: owner.threadId,
    persisted: true,
  });
  expect(f.selectSession).toHaveBeenNthCalledWith(2, {
    projectId: owner.projectId,
    threadId: owner.threadId,
  });
  expect(f.command.mock.calls.map(([name]) => name)).not.toContain("send");
});

it("reads saved history before verification and prewarms once Main verifies the Host", async () => {
  seed.selectedProject = owner.projectId;
  seed.snapshot = {
    connection: { state: "ready" },
    projects: [
      {
        id: owner.projectId,
        root: "/fixture",
        state: {
          connected: false,
          threads: { [owner.threadId]: { id: owner.threadId, persistedHistory: true } },
        },
      },
    ],
  };
  const f = fixture(true, async () => {}, false, true);
  let verified = false;
  f.services.reads!.canPrewarm = () => verified;
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events).toEqual(["read"]);
  expect(seed.restoration?.pending).toBe(false);
  expect(seed.restoration?.failure).toBeUndefined();
  verified = true;
  f.navigation.synchronizeRestoration();
  await f.navigation.pendingRestoration();
  expect(f.events).toEqual(["read", "read", "connect", "read"]);
  f.navigation.synchronizeRestoration();
  expect(f.command).toHaveBeenCalledTimes(1);
});

it("drops a rejection from the old Host even when the stopped project's Core generation is unchanged", async () => {
  seed.hostGeneration = "old";
  let reject!: (error: Error) => void;
  const connect = vi
    .fn<(resume: boolean) => Promise<void>>()
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(undefined);
  const f = fixture(true, connect, false, true);
  const first = f.navigation.selectConversation(owner.projectId, owner.threadId);
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  seed.hostGeneration = "new";
  reject(Object.assign(Error("old Host retired"), { code: "CORE_UNAVAILABLE" }));
  await first;
  expect(seed.restoration?.failure).toBeUndefined();

  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events).toEqual(["read", "connect", "read", "connect", "read"]);
  expect(seed.restoration).toMatchObject({
    hostGeneration: JSON.stringify(["host", "new"]),
    connectionGeneration: 0,
    pending: false,
  });
});

it.each([
  { history: true, manual: false, expectedError: false },
  { history: false, manual: false, expectedError: true },
  { history: true, manual: true, expectedError: true },
  {
    history: true,
    manual: false,
    failureFields: { submissionUnknown: true },
    expectedError: true,
  },
  {
    history: true,
    manual: false,
    failureFields: { recovery: { kind: "needsUser" } },
    expectedError: true,
  },
])("reports Host stop only when it affects the request: %o", async (scenario) => {
  const failure = Object.assign(Error("Host stop intent prevents activation"), {
    code: "stopInProgress",
    ...scenario.failureFields,
  });
  const f = fixture(
    true,
    async () => {
      throw failure;
    },
    false,
    scenario.history,
  );
  await f.navigation.restoreConversation(owner, "connect", { resumeScheduling: scenario.manual });
  expect(f.events).toEqual(scenario.history ? ["read", "connect"] : ["connect"]);
  expect(seed.restoration?.pending).toBe(false);
  expect(seed.restoration?.failure).toBe(scenario.expectedError ? failure : undefined);
});

it("does not activate execution for an observe-only desktop", async () => {
  const f = fixture(
    true,
    async () => {
      throw Error("must not activate");
    },
    false,
    true,
  );
  Object.assign(f.services.capabilities!, { mutations: false });
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events).toEqual(["read"]);
  expect(f.command).not.toHaveBeenCalled();
});

it("recovers from stale open Project Core unavailable by refreshing and connecting on retry", async () => {
  seed.snapshot = {
    connection: { state: "ready" },
    projects: [{ id: owner.projectId, root: "/fixture", state: { connected: true, threads: {} } }],
  };
  let hostReady = false;
  const f = fixture(true, async () => {
    hostReady = true;
  });
  const refreshProjects = vi.fn(async () => {
    f.events.push("refresh");
  });
  Object.assign(f.services.reads!, { refreshProjects });
  f.selectSession.mockImplementation(async () => {
    f.events.push("read");
    if (!hostReady) throw new Error("Project Core unavailable");
  });

  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events.filter((event) => event !== "library")).toEqual([
    "read",
    "refresh",
    "read",
    "connect",
    "refresh",
    "read",
  ]);
  expect(seed.restoration).toMatchObject({ pending: false, error: "" });
});

it("retryRestoration reconnects when previous load failed with Project Core unavailable", async () => {
  seed.snapshot = {
    connection: { state: "ready" },
    projects: [{ id: owner.projectId, root: "/fixture", state: { connected: true, threads: {} } }],
  };
  let allowOpen = false;
  const f = fixture(true, async () => {
    allowOpen = true;
  });
  const refreshProjects = vi.fn(async () => {
    f.events.push("refresh");
  });
  Object.assign(f.services.reads!, { refreshProjects });
  f.selectSession.mockImplementation(async () => {
    f.events.push("read");
    if (!allowOpen) throw new Error("Project Core unavailable");
  });

  await f.navigation.restoreConversation(owner, "connect");
  expect(seed.restoration?.failure?.message).toBe("Project Core unavailable");

  f.events.length = 0;
  await f.navigation.retryRestoration();
  expect(f.events.filter((event) => event !== "library")).toEqual(["connect", "refresh", "read"]);
  expect(seed.restoration).toMatchObject({ pending: false, error: "" });
});

it("keeps loaded persisted history when live open still reports Project Core unavailable", async () => {
  const f = fixture(true, async () => {}, false, true);
  Object.assign(f.services.reads!, { refreshProjects: vi.fn(async () => {}) });
  f.selectSession.mockImplementation(async (target) => {
    f.events.push(target?.persisted ? "persisted" : "live");
    if (!target?.persisted) throw new Error("Project Core unavailable");
  });

  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events.filter((event) => event !== "library")).toEqual([
    "persisted",
    "connect",
    "live",
    "persisted",
  ]);
  expect(seed.restoration).toMatchObject({ pending: false, error: "" });
});

it("does not automatically wake Core when an open conversation enters idle hibernation", async () => {
  seed.selectedProject = owner.projectId;
  seed.snapshot = {
    connection: { state: "ready" },
    projects: [
      {
        id: owner.projectId,
        root: "/fixture",
        core: { connectionGeneration: "" },
        scheduling: { suppressed: false, activationError: null },
        state: {
          connected: false,
          hostState: "stopped",
          threads: { [owner.threadId]: { id: owner.threadId, turns: [] } },
        },
      },
    ],
  };
  const f = fixture(true, async () => {}, false, true);
  // Simulate that the conversation was already opened under the previous live Core generation.
  await f.navigation.restoreConversation({ ...owner, connectionGeneration: 1 }, "open");
  f.events.length = 0;

  // Now Host has hibernated the project (connected: false, hostState: "stopped", generation: "").
  f.navigation.synchronizeRestoration();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.events).toEqual([]);
});

it.each(["host", "socket"])(
  "restores an idle empty project after its %s connection changes",
  async (change) => {
    seed.selectedProject = owner.projectId;
    seed.hostGeneration = "old-host";
    seed.connectionId = "old-socket";
    seed.snapshot = {
      connection: { state: "ready" },
      projects: [
        {
          id: owner.projectId,
          root: "/fixture",
          state: { connected: false, hostState: "stopped", threads: {} },
        },
      ],
    };
    const f = fixture(true, async () => {}, false, true, "");
    await f.navigation.restoreConversation(f.navigation.restorationOwner, "open");
    f.events.length = 0;
    f.navigation.synchronizeRestoration();
    expect(f.events).toEqual([]);

    // 模拟新投影的 owner；Core 仍休眠，但旧连接的恢复结果不能满足新连接。
    seed.hostGeneration = change === "host" ? "new-host" : "old-host";
    seed.connectionId = "new-socket";
    Object.assign(f.navigation.restorationOwner, {
      hostGeneration: JSON.stringify(["host", seed.hostGeneration]),
      connectionId: seed.connectionId,
    });
    f.navigation.synchronizeRestoration();
    await f.navigation.pendingRestoration();

    expect(f.events).toEqual(["connect", "read"]);
    expect(seed.restoration).toMatchObject({
      ...f.navigation.restorationOwner,
      pending: false,
      error: "",
    });
    expect(f.selectSession).toHaveBeenLastCalledWith(null);
  },
);

it.each(["host", "socket"])(
  "ignores the old idle project's rejection after a %s handoff restores it",
  async (change) => {
    seed.selectedProject = owner.projectId;
    seed.hostGeneration = "old-host";
    seed.connectionId = "old-socket";
    seed.snapshot = {
      connection: { state: "ready" },
      projects: [
        {
          id: owner.projectId,
          root: "/fixture",
          state: { connected: false, hostState: "stopped", threads: {} },
        },
      ],
    };
    let rejectOld!: (cause: Error) => void;
    const connect = vi
      .fn<(resume: boolean) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const f = fixture(true, connect, false, true, "");
    const original = f.navigation.restoreConversation(
      { ...f.navigation.restorationOwner },
      "connect",
    );
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    seed.hostGeneration = change === "host" ? "new-host" : "old-host";
    seed.connectionId = "new-socket";
    Object.assign(f.navigation.restorationOwner, {
      hostGeneration: JSON.stringify(["host", seed.hostGeneration]),
      connectionId: seed.connectionId,
    });
    f.navigation.synchronizeRestoration();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await f.navigation.pendingRestoration();
    rejectOld(Object.assign(Error("old connection retired"), { code: "CORE_UNAVAILABLE" }));
    await original;
    expect(seed.restoration).toMatchObject({
      ...f.navigation.restorationOwner,
      pending: false,
      error: "",
    });
    expect(seed.restoration?.failure).toBeUndefined();
  },
);

it.each(["sidebar", "startup", "retry"])(
  "reads saved history from %s before verifying execution",
  async (entry) => {
    seed.selectedProject = owner.projectId;
    seed.snapshot = {
      connection: { state: "ready" },
      projects: [
        { id: owner.projectId, root: "/fixture", state: { connected: true, threads: {} } },
      ],
    };
    const f = fixture(true, async () => {}, false, true);
    f.services.reads!.canPrewarm = () => false;
    const refreshed = vi.fn(async () => {});
    f.services.reads!.refreshProjects = refreshed;
    f.selectSession.mockImplementation(async (target) => {
      if (!target?.persisted) throw new Error("Project Core unavailable");
    });
    if (entry === "sidebar") await f.navigation.selectConversation(owner.projectId, owner.threadId);
    if (entry === "startup") {
      f.navigation.synchronizeRestoration();
      await f.navigation.pendingRestoration();
    }
    if (entry === "retry") {
      await f.navigation.restoreConversation(owner, "connect");
      expect(seed.restoration?.failure?.message).toBe("Project Core unavailable");
      await f.navigation.retryRestoration();
    }
    if (entry !== "retry") expect(refreshed).toHaveBeenCalledOnce();
    expect(f.selectSession).toHaveBeenLastCalledWith({
      projectId: owner.projectId,
      threadId: owner.threadId,
      persisted: true,
    });
    expect(seed.restoration).toMatchObject({ pending: false, error: "" });
    expect(f.command).not.toHaveBeenCalled();
  },
);

it("opens the new live generation when Core acquires the store during a saved read", async () => {
  const f = fixture(
    true,
    async () => {
      throw new Error("duplicate activation");
    },
    false,
    true,
  );
  f.services.reads!.refreshProjects = async () => {
    f.events.push("refresh");
  };
  f.selectSession.mockImplementation(async (target) => {
    if (target?.persisted) throw Object.assign(new Error("busy"), { code: "RESOURCE_BUSY" });
    f.events.push("live");
  });
  await f.navigation.selectConversation(owner.projectId, owner.threadId);
  expect(f.events.filter((event) => event !== "library")).toEqual(["refresh", "live"]);
  expect(seed.restoration).toMatchObject({ pending: false, error: "" });
});

it("connects the foreground empty project without submitting an empty thread ID", async () => {
  const f = fixture(true, async () => {}, false, false, "");
  await f.navigation.restoreConversation({ ...owner, threadId: "" }, "connect");
  expect(f.command).toHaveBeenCalledWith("connect", { projectId: owner.projectId });
  expect(f.selectSession).toHaveBeenCalledExactlyOnceWith(null);
});

it("explicitly resumes an empty project without adding an empty thread identity", async () => {
  const f = fixture(
    true,
    async (resume) => {
      expect(resume).toBe(true);
    },
    false,
    false,
    "",
  );
  await f.navigation.restoreConversation({ ...owner, threadId: "" }, "connect", {
    resumeScheduling: true,
  });
  expect(f.command).toHaveBeenCalledWith("connect", {
    projectId: owner.projectId,
    resumeScheduling: true,
  });
  expect(f.selectSession).toHaveBeenCalledExactlyOnceWith(null);
});
