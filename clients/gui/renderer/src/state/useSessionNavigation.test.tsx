import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { PlatformServices } from "../services.js";
import { useSessionNavigation } from "./useSessionNavigation.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(
  native: boolean,
  connect: (resume: boolean) => Promise<void>,
  recoveryOnly = false,
) {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
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
  const selectSession = vi.fn(async () => {
    events.push("read");
  });
  const services = {
    capabilities: { native, mutations: true },
    workbench: { call: command },
    reads: {
      selectSession,
      status: () => ({ connection: "ready", identity: { persistedHistory: true } }),
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
  renderToStaticMarkup(createElement(Harness));
  if (!navigation) throw Error("Navigation not mounted");
  return { navigation, command, selectSession, recoverPersistedHistory, events };
}
const owner = { projectId: "saved-project", threadId: "old-thread", connectionGeneration: 0 };

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
        expect(f.command).toHaveBeenCalledWith("connect", { projectId: owner.projectId }),
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
  expect(f.command).toHaveBeenCalledWith("connect", { projectId: owner.projectId });
  await f.navigation.restoreConversation(owner, "connect", { resumeScheduling: true });
  expect(f.command).toHaveBeenLastCalledWith("connect", {
    projectId: owner.projectId,
    resumeScheduling: true,
  });
  expect(f.selectSession).toHaveBeenCalledTimes(1);
});

it("opens a persisted read-only history when the old owner blocks activation", async () => {
  const f = fixture(true, async () => {
    throw Object.assign(Error("old owner"), { code: "migrationBlocked" });
  });
  await f.navigation.restoreConversation(owner, "connect");
  expect(f.selectSession).toHaveBeenCalledWith({
    projectId: owner.projectId,
    threadId: owner.threadId,
    persisted: true,
  });
  expect(f.command).toHaveBeenCalledTimes(1);
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
