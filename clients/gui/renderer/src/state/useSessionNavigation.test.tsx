import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { PlatformServices } from "../services.js";
import { useSessionNavigation } from "./useSessionNavigation.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(native: boolean, connect: (resume: boolean) => Promise<void>) {
  vi.stubGlobal("localStorage", { getItem: () => null });
  const events: string[] = [];
  const command = vi.fn(async (name: string, params: Record<string, unknown>) => {
    events.push(name);
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
    reads: { selectSession },
  } as unknown as PlatformServices;
  let navigation: ReturnType<typeof useSessionNavigation> | undefined;
  function Harness() {
    navigation = useSessionNavigation(services, vi.fn());
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (!navigation) throw Error("Navigation not mounted");
  return { navigation, command, selectSession, events };
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

it("opens history on an already connected project without launching it again", async () => {
  const f = fixture(true, async () => {
    throw Error("unexpected connect");
  });
  await f.navigation.restoreConversation(owner, "open");
  expect(f.command).not.toHaveBeenCalled();
  expect(f.selectSession).toHaveBeenCalledTimes(1);
});
