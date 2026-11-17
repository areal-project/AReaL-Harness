import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { PlatformServices, Snapshot } from "../services.js";
import { useSessionNavigation } from "./useSessionNavigation.js";

const seed = vi.hoisted(() => ({
  snapshot: undefined as Snapshot | undefined,
  selectedProject: undefined as string | undefined,
  stateIndex: 0,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const selected = seed.stateIndex++ === 2 && seed.selectedProject;
      return react.useState(
        selected ||
          (seed.snapshot && initial && typeof initial === "object" && "projects" in initial
            ? seed.snapshot
            : initial),
      );
    },
  };
});
afterEach(() => {
  seed.snapshot = undefined;
  seed.selectedProject = undefined;
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
      status: () => ({ connection: "ready", identity: { persistedHistory } }),
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

it("reads stopped project history without activating its execution", async () => {
  const f = fixture(
    true,
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

it("reads persisted history without probing a blocked execution owner", async () => {
  const f = fixture(
    true,
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

it("does not attempt an uncertain activation when persisted history is available", async () => {
  const f = fixture(
    true,
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
