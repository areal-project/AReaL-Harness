import { describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostClientOptions, ShellProject, SourceNavigation } from "@areal/client";
import { createHostReadServices } from "./host-services.js";
import type { Action, PlatformServices, Snapshot } from "./services.js";
import { PlatformReadProvider } from "./PlatformReadContext.js";
import { useConversationHistory } from "./ConversationHistory.js";
import { draftModelOptions, draftModelSelection } from "./lib/draftModelSelection.js";
import { resolveDraftProfile } from "./ProfileDetails.js";
import { recoveredOutcome } from "./recoveryPresentation.js";
import { ProjectMigrationNotice } from "./views/ProjectMigrationNotice.js";
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
const connection = {
  hostId: "host",
  hostGeneration: "host-gen",
  connectionId: "connection",
  gatewayGeneration: "gateway-gen",
};
const project = {
  projectId: "canonical",
  alias: { sourceId: "source", projectId: "alias" },
  workspace: "/canonical",
  projectless: false,
  state: "ready",
  serviceGeneration: "core-gen",
  summaries: {
    state: "fresh",
    items: [{ id: "thread", name: "Host title", desktop: { archived: false } }],
  },
  attention: { state: "unknown" },
} satisfies ShellProject;
const navigation = {
  sourceId: "source",
  preferences: { sidebarSort: "manual" },
  settings: {},
  state: "available",
  bindings: [{ projectId: "canonical", alias: "alias", projectless: false }],
  projects: { alias: { title: "Host project title" } },
  threads: {},
  projectOrder: ["alias"],
  sections: [],
  sidebarThreadOrder: [],
  sidebarRevision: 1,
} satisfies SourceNavigation;
const identity = {
  connectionId: connection.connectionId,
  gatewayGeneration: connection.gatewayGeneration,
  subscriptionId: "session",
  projectId: "canonical",
  serviceGeneration: "core-gen",
  threadId: "thread",
  view: "conversation",
  sequence: 0,
};
const entry = {
  sourceThreadId: "original-thread",
  sourceTurnId: "original-turn",
  sourceItemId: "original-item",
  sourceTurnStatus: "completed",
  turn: { id: "original-turn", status: "completed" },
  item: {
    id: "original-item",
    type: "userMessage",
    content: [{ type: "image", media: { uri: "core://native/media" } }],
  },
};
const observation = {
  thread: {
    id: "thread",
    name: "Host thread",
    turns: [
      {
        id: "latest-turn",
        status: "completed",
        items: [{ id: "latest-item", type: "dynamicToolCall", arguments: { native: [1, 2] } }],
      },
    ],
  },
  history: { snapshotId: "history", complete: false, nextCursor: "native-older" },
};
function until(services: PlatformServices) {
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      stop();
      reject(new Error("Projection deadline"));
    }, 2000);
    const accept = (snapshot: Snapshot) => {
      if (snapshot.connection?.state === "ready") {
        clearTimeout(deadline);
        stop();
        resolve();
      }
    };
    const stop = services.onState(accept);
    void services.snapshot().then(accept);
  });
}
function transport(
  native: unknown = observation,
  page: (params: Record<string, unknown>) => unknown = () => ({
    snapshotId: "history",
    complete: true,
    nextCursor: null,
    data: [entry],
  }),
  shell: unknown = { projects: [project], navigation: [navigation] },
) {
  const requests: {
    method: string;
    params: Record<string, unknown>;
    context?: { projectId: string; serviceGeneration?: string };
  }[] = [];
  let event: (value: unknown) => void = () => {};
  let sessionSequence = 0;
  const factory: NonNullable<HostClientOptions["transport"]> = async (lifecycle) => {
    event = lifecycle.onEvent;
    return {
      identity: connection,
      transport: {
        close() {},
        async request(method, params, context) {
          requests.push({ method, params, context });
          if (method === "shell.subscribe")
            return {
              ...identity,
              subscriptionId: "shell",
              snapshot: shell,
            };
          if (method === "session.open")
            return { ...identity, ...context, threadId: params.threadId, snapshot: native };
          if (method === "session.history")
            return { ...identity, sequence: sessionSequence, page: page(params) };
          return { closed: true };
        },
      },
    };
  };
  return {
    factory,
    requests,
    send(value: unknown) {
      if (
        typeof value === "object" &&
        value !== null &&
        "event" in value &&
        value.event === "session.updated" &&
        "sequence" in value &&
        typeof value.sequence === "number"
      )
        sessionSequence = value.sequence;
      event(value);
    },
  };
}
function options(factory: NonNullable<HostClientOptions["transport"]>): HostClientOptions {
  return {
    origin: "areal-ui://app",
    bootstrap: async () => {
      throw new Error("Unused bootstrap");
    },
    transport: factory,
  };
}
describe("Host renderer read authority", () => {
  it("projects a stopped project's persisted history as read-only without marking it connected", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const stopped = { ...project, state: "stopped" as const, serviceGeneration: undefined };
    const wire = transport(observation, undefined, {
      projects: [stopped],
      navigation: [navigation],
    });
    const factory: NonNullable<HostClientOptions["transport"]> = async (lifecycle) => {
      const base = await wire.factory(lifecycle);
      return {
        ...base,
        identity: { ...base.identity, persistedHistory: true },
        transport: {
          ...base.transport,
          async request(method, params, context) {
            if (method === "session.openPersisted")
              return {
                ...identity,
                ...context,
                serviceGeneration: "old-gen",
                threadId: params.threadId,
                snapshot: observation,
                access: { kind: "persisted", readOnly: true, snapshotId: "snapshot" },
              };
            return base.transport.request(method, params, context);
          },
        },
      };
    };
    const services = createHostReadServices(undefined, options(factory));
    try {
      await until(services);
      await services.reads!.selectSession({
        projectId: "alias",
        threadId: "thread",
        persisted: true,
      });
      const owner = (await services.snapshot()).projects[0];
      expect(owner.state.connected).toBe(false);
      expect(owner.state.threads.thread).toMatchObject({ persistedHistory: true });
    } finally {
      page.dispatchEvent(new Event("pagehide"));
      vi.unstubAllGlobals();
    }
  });
  it("shows migration recovery only for the pending project and clears it after Host publication", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const blocked = {
      ...project,
      projectId: "blocked",
      alias: { sourceId: "source", projectId: "blocked-alias" },
      workspace: "/blocked",
      state: "legacyPending" as const,
      serviceGeneration: "",
      summaries: { state: "unknown" as const, items: [] },
    };
    const wire = transport(observation, undefined, {
      projects: [project, blocked],
      navigation: [
        {
          ...navigation,
          bindings: [
            ...navigation.bindings,
            { projectId: "blocked", alias: "blocked-alias", projectless: false },
          ],
        },
      ],
    });
    const services = createHostReadServices(undefined, options(wire.factory));
    const notice = (owner: Snapshot["projects"][number]) =>
      renderToStaticMarkup(createElement(ProjectMigrationNotice, { project: owner }));
    try {
      await until(services);
      const before = await services.snapshot();
      const pending = before.projects.find((owner) => owner.id === "blocked-alias")!;
      expect(pending.state.connected).toBe(false);
      expect(notice(pending)).toContain('role="status"');
      expect(notice(before.projects.find((owner) => owner.id === "alias")!)).toBe("");
      wire.send({
        event: "shell.updated",
        ...connection,
        subscriptionId: "shell",
        sequence: 1,
        delta: {
          projects: {
            upsert: [{ ...blocked, state: "ready", serviceGeneration: "published-gen" }],
            remove: [],
          },
          navigation: { upsert: [], remove: [] },
        },
      });
      const restored = (await services.snapshot()).projects.find(
        (owner) => owner.id === "blocked-alias",
      )!;
      expect(restored.state.connected).toBe(true);
      expect(notice(restored)).toBe("");
      expect(wire.requests.map((request) => request.method)).toEqual(["shell.subscribe"]);
    } finally {
      page.dispatchEvent(new Event("pagehide"));
      vi.unstubAllGlobals();
    }
  });

  it("preserves a stopped project's terminal state without opening or waking it", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const wire = transport(observation, undefined, {
      projects: [{ ...project, state: "stopped", serviceGeneration: "" }],
      navigation: [navigation],
    });
    const services = createHostReadServices(undefined, options(wire.factory));
    try {
      await until(services);
      await services.reads!.selectSession(null);
      const snapshot = await services.snapshot();
      expect(snapshot.projects[0].state.hostState).toBe("stopped");
      expect(snapshot.projects[0].state.connected).toBe(false);
      expect(wire.requests.map((request) => request.method)).toEqual(["shell.subscribe"]);
    } finally {
      page.dispatchEvent(new Event("pagehide"));
      vi.unstubAllGlobals();
    }
  });

  it("retains the execution project's stopped state under a ready logical project", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const wire = transport(observation, undefined, {
      projects: [
        project,
        {
          ...project,
          projectId: "worktree",
          alias: { sourceId: "source", projectId: "worktree-alias" },
          logicalProjectId: "canonical",
          state: "stopped",
          serviceGeneration: "",
          summaries: {
            state: "fresh",
            items: [{ id: "worktree-thread", name: "Worktree", desktop: { archived: false } }],
          },
        },
      ],
      navigation: [navigation],
    });
    const services = createHostReadServices(undefined, options(wire.factory));
    try {
      await until(services);
      const snapshot = await services.snapshot();
      const logical = snapshot.projects[0];
      expect(logical.state.hostState).toBe("ready");
      expect(
        logical.summaries.find((row: { id: string }) => row.id === "worktree-thread"),
      ).toMatchObject({
        executionConnected: false,
        executionHostState: "stopped",
      });
    } finally {
      page.dispatchEvent(new Event("pagehide"));
      vi.unstubAllGlobals();
    }
  });
  it.each([false, true])(
    "advertises domain grants independently of native and session mutations: %s",
    async (permitted) => {
      const page = new EventTarget();
      vi.stubGlobal("window", page);
      const wire = transport();
      const factory: NonNullable<HostClientOptions["transport"]> = async (lifecycle) => {
        const connected = await wire.factory(lifecycle);
        return {
          ...connected,
          transport: {
            ...connected.transport,
            write: async () => {
              throw new Error("Unexpected mutation");
            },
          },
          identity: {
            ...connected.identity,
            writeMethods: permitted
              ? [
                  "library.command",
                  "tasks.read",
                  "manage.command",
                  "providers.read",
                  "pages.command",
                  "pages.resource",
                ]
              : [],
            writeLimits: {},
          },
        };
      };
      const services = createHostReadServices(undefined, {
        ...options(factory),
        events: page as Window,
      });
      try {
        await until(services);
        expect(services.capabilities).toEqual({
          library: permitted,
          taskCatalog: permitted,
          taskManage: permitted,
          pages: permitted,
          settings: permitted ? ["模型服务"] : [],
          mutations: false,
          conversationSubmit: false,
          conversationCreate: false,
          native: false,
        });
      } finally {
        page.dispatchEvent(new Event("pagehide"));
        vi.unstubAllGlobals();
      }
    },
  );

  it("keeps model and profile consumers usable before desktop catalogs arrive", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const wire = transport();
    const services = createHostReadServices(undefined, options(wire.factory));
    try {
      await until(services);
      const snapshot = await services.snapshot();
      const projected = snapshot.projects.find((item) => item.id === "alias");
      if (!projected) throw new Error("Host shell did not publish its project");
      const selection = draftModelSelection(projected, undefined, null, {});
      expect(selection.effectiveModel).toBe("");
      expect(
        draftModelOptions(projected, selection.effectiveModel, selection.currentModel),
      ).toEqual([]);
      expect(resolveDraftProfile(projected, '{"id":"historical","revision":"1"}')).toBeUndefined();
    } finally {
      page.dispatchEvent(new Event("pagehide"));
      vi.unstubAllGlobals();
    }
  });

  it("reconnects after a persisted page returns without permanently closing its read owner", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const source = transport();
    const services = createHostReadServices(undefined, {
      ...options(source.factory),
      events: page as Window,
    });
    const transition = (name: string, persisted: boolean) => {
      const event = new Event(name);
      Object.defineProperty(event, "persisted", { value: persisted });
      page.dispatchEvent(event);
    };
    try {
      await until(services);
      const before = source.requests.filter(
        (request) => request.method === "shell.subscribe",
      ).length;
      transition("pagehide", true);
      transition("pageshow", true);
      await until(services);
      expect(source.requests.filter((request) => request.method === "shell.subscribe").length).toBe(
        before + 1,
      );
    } finally {
      transition("pagehide", false);
      vi.unstubAllGlobals();
    }
  });

  it("keeps an unchanged native reading window and cursor for a stale revisit", async () => {
    const wire = transport(observation, (params) => ({
      snapshotId: "history",
      complete: false,
      nextCursor: params.cursor === "native-older" ? "retained-next" : "following-next",
      data: [entry],
    }));
    let release: (() => void) | undefined;
    let deferOpen = false;
    const factory: NonNullable<HostClientOptions["transport"]> = async (lifecycle) => {
      const connection = await wire.factory(lifecycle);
      return {
        ...connection,
        transport: {
          ...connection.transport,
          async request(method, params, context) {
            if (method === "session.open" && deferOpen)
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            return connection.transport.request(method, params, context);
          },
        },
      };
    };
    const services = createHostReadServices(undefined, options(factory));
    await until(services);
    const target = { projectId: "alias", threadId: "thread" };
    await services.reads!.selectSession(target);
    await services.reads!.loadOlder();
    await services.reads!.selectSession(null);
    deferOpen = true;
    const revisit = services.reads!.selectSession(target);
    const stale = (await services.snapshot()).projects[0].state.threads.thread;
    expect(stale.turns[0].items[0].id).toBe("original-item");
    expect(stale.displayHistory.freshness).toBe("stale");
    await expect(services.reads!.loadOlder()).rejects.toThrow("unavailable");
    release!();
    await revisit;
    await services.reads!.loadOlder();
    expect(
      wire.requests
        .filter((request) => request.method === "session.history")
        .map((request) => request.params.cursor),
    ).toEqual(["native-older", "retained-next"]);
  });

  it("expires left-session pages and never reuses a changed native window cursor", async () => {
    const wire = transport(observation, () => ({
      snapshotId: "history",
      complete: false,
      nextCursor: "retained-next",
      data: [entry],
    }));
    const services = createHostReadServices(undefined, options(wire.factory));
    await until(services);
    const target = { projectId: "alias", threadId: "thread" };
    await services.reads!.selectSession(target);
    await services.reads!.loadOlder();
    await services.reads!.selectSession(null);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60 * 1000 + 1);
    try {
      await services.reads!.selectSession(target);
      const thread = (await services.snapshot()).projects[0].state.threads.thread;
      expect(thread.turns).toHaveLength(1);
      await services.reads!.loadOlder();
      expect(
        wire.requests.filter((request) => request.method === "session.history").at(-1)?.params
          .cursor,
      ).toBe("native-older");
    } finally {
      clock.mockRestore();
    }
    wire.send({
      ...identity,
      event: "session.updated",
      sequence: 1,
      patch: {
        head: {
          ...observation,
          history: { snapshotId: "replacement", nextCursor: "replacement-older", complete: false },
        },
        turns: [],
      },
    });
    const changed = (await services.snapshot()).projects[0].state.threads.thread;
    expect(changed.turns).toHaveLength(1);
    expect(changed.displayHistory.pageTopology).toEqual([]);
    await expect(services.reads!.loadOlder()).rejects.toThrow("snapshot changed");
    expect(
      wire.requests.filter((request) => request.method === "session.history").at(-1)?.params.cursor,
    ).toBe("replacement-older");
  });

  it("bounds resident pages around native cursors while preserving pinned reading anchors and gap recovery", async () => {
    const pageEntry = (index: number) => ({
      ...entry,
      sourceTurnId: `turn-${index}`,
      sourceItemId: `item-${index}`,
      turn: { id: `turn-${index}`, status: "completed" },
      item: { id: `item-${index}`, type: "agentMessage", text: `body-${index}` },
    });
    const native = { ...observation, history: { ...observation.history, nextCursor: "page-1" } };
    const wire = transport(native, (params) => {
      const index = Number(String(params.cursor).split("-").at(-1));
      return {
        snapshotId: "history",
        complete: index === 40,
        nextCursor: index === 40 ? null : `page-${index + 1}`,
        data: [pageEntry(index)],
      };
    });
    const services = createHostReadServices(undefined, options(wire.factory));
    await until(services);
    const reads = services.reads!;
    await reads.selectSession({ projectId: "alias", threadId: "thread" });
    await reads.loadOlder();
    const getThread = async () => (await services.snapshot()).projects[0].state.threads.thread;
    const initial = await getThread();
    const generation = initial.displayHistory.viewGeneration;
    let history!: ReturnType<typeof useConversationHistory>;
    const action: Action = async () => {
      throw new Error("Native command must not run for Host history");
    };
    function ReadingView() {
      history = useConversationHistory("alias", initial, action);
      return null;
    }
    renderToStaticMarkup(
      createElement(PlatformReadProvider, { reads, children: createElement(ReadingView) }),
    );
    await reads.acquire("viewport", generation);
    await reads.retain("viewport", 1, { turnId: "turn-1", itemId: "item-1" }, generation);
    for (let index = 1; index < 36; ++index) await reads.loadOlder();
    const thread = await getThread();
    const ids = thread.turns.flatMap((turn: { items: { id: string }[] }) =>
      turn.items.map((item) => item.id),
    );
    expect(ids).toHaveLength(17);
    expect(ids).toContain("item-1");
    expect(ids).toContain("item-36");
    expect(ids).toContain("latest-item");
    expect(ids).not.toContain("item-2");
    expect(thread.displayHistory.gaps).toHaveLength(1);
    const gap = thread.displayHistory.gaps[0];
    expect(await history.load(undefined, gap.id)).toBe(true);
    expect(
      wire.requests.filter((request) => request.method === "session.history").at(-1)?.params.cursor,
    ).toBe("page-21");
    expect(
      (await getThread()).turns
        .flatMap((turn: { items: { id: string }[] }) => turn.items)
        .map((item: { id: string }) => item.id),
    ).toContain("item-21");
    expect(
      await history.ensure(1, { turnId: "turn-2", itemId: "item-2", blockIndex: null, offset: 0 }),
    ).toBe("ready");
    expect(
      wire.requests.filter((request) => request.method === "session.history").at(-1)?.params.cursor,
    ).toBe("page-2");
    const recovered = (await getThread()).turns
      .flatMap((turn: { items: { id: string }[] }) => turn.items)
      .map((item: { id: string }) => item.id);
    expect(recovered).toHaveLength(17);
    expect(recovered).toContain("item-1");
    expect(recovered).toContain("item-2");
    expect(
      await history.ensure(0, { turnId: "turn-3", itemId: "item-3", blockIndex: null, offset: 0 }),
    ).toBe("cancelled");
    expect(
      wire.requests.every((request) =>
        ["shell.subscribe", "session.open", "session.history"].includes(request.method),
      ),
    ).toBe(true);
  });

  it("discards an old own page after the same subscription receives a replacement native window", async () => {
    const wire = transport();
    let release: (() => void) | undefined;
    const factory: NonNullable<HostClientOptions["transport"]> = async (lifecycle) => {
      const connection = await wire.factory(lifecycle);
      return {
        ...connection,
        transport: {
          ...connection.transport,
          async request(method, params, context) {
            if (method === "session.history")
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            return connection.transport.request(method, params, context);
          },
        },
      };
    };
    const services = createHostReadServices(undefined, options(factory));
    await until(services);
    await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
    const pending = services.reads!.loadOlder();
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await Promise.resolve();
    wire.send({
      ...identity,
      event: "session.updated",
      sequence: 1,
      patch: {
        head: {
          ...observation,
          history: { snapshotId: "replacement", nextCursor: "new-cursor", complete: false },
        },
        turns: [],
      },
    });
    release!();
    await rejection;
    const thread = (await services.snapshot()).projects[0].state.threads.thread;
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].items[0].id).toBe("latest-item");
    expect(thread.displayHistory.pageTopology).toEqual([]);
  });

  it("refuses a seventeenth pinned page without moving the authoritative cursor", async () => {
    const wire = transport(observation, (params) => {
      const index = params.cursor === "native-older" ? 1 : Number(params.cursor);
      return {
        snapshotId: "history",
        complete: false,
        nextCursor: String(index + 1),
        data: [
          {
            ...entry,
            sourceTurnId: `turn-${index}`,
            sourceItemId: `item-${index}`,
            turn: { id: `turn-${index}`, status: "completed" },
            item: { id: `item-${index}`, type: "agentMessage", text: "body" },
          },
        ],
      };
    });
    const services = createHostReadServices(undefined, options(wire.factory));
    await until(services);
    const reads = services.reads!;
    await reads.selectSession({ projectId: "alias", threadId: "thread" });
    const generation = (await services.snapshot()).projects[0].state.threads.thread.displayHistory
      .viewGeneration;
    for (let index = 1; index <= 16; ++index) {
      await reads.loadOlder();
      await reads.retain(
        `reader-${index}`,
        1,
        { turnId: `turn-${index}`, itemId: `item-${index}` },
        generation,
      );
    }
    const before = (await services.snapshot()).projects[0].state.threads.thread;
    await expect(reads.loadOlder()).rejects.toThrow("pinned");
    const refused = (await services.snapshot()).projects[0].state.threads.thread;
    expect(refused.turns).toEqual(before.turns);
    expect(refused.displayHistory.pageTopology).toEqual(before.displayHistory.pageTopology);
    await reads.release("reader-1", generation);
    await reads.loadOlder();
    expect(
      wire.requests
        .filter((request) => request.method === "session.history")
        .slice(-2)
        .map((request) => request.params.cursor),
    ).toEqual(["17", "17"]);
    expect((await services.snapshot()).projects[0].state.threads.thread.turns).toHaveLength(17);
  });

  it("bounds topology descriptions and scans unknown gaps to recover a native anchor", async () => {
    const itemId = (page: number, item: number) => `${page}-${item}-${"native-source-".repeat(5)}`;
    const native = { ...observation, history: { ...observation.history, nextCursor: "1" } };
    const wire = transport(native, (params) => {
      const page = Number(params.cursor);
      return {
        snapshotId: "history",
        complete: false,
        nextCursor: String(page + 1),
        data: Array.from({ length: 100 }, (_, index) => ({
          ...entry,
          sourceTurnId: `turn-${page}`,
          sourceItemId: itemId(page, index),
          turn: { id: `turn-${page}`, status: "completed" },
          item: { id: itemId(page, index), type: "agentMessage", text: "body" },
        })),
      };
    });
    const services = createHostReadServices(undefined, options(wire.factory));
    await until(services);
    const reads = services.reads!;
    await reads.selectSession({ projectId: "alias", threadId: "thread" });
    const generation = (await services.snapshot()).projects[0].state.threads.thread.displayHistory
      .viewGeneration;
    await reads.loadOlder();
    await reads.retain("pin", 1, { turnId: "turn-1", itemId: itemId(1, 0) }, generation);
    for (let index = 1; index < 40; ++index) await reads.loadOlder();
    const thread = (await services.snapshot()).projects[0].state.threads.thread;
    expect(thread.turns.flatMap((turn: { items: unknown[] }) => turn.items)).toHaveLength(1601);
    expect(
      new TextEncoder().encode(JSON.stringify(thread.displayHistory.pageTopology)).length,
    ).toBeLessThanOrEqual(64 * 1024);
    expect(
      thread.displayHistory.gaps.some((gap: { topologyKnown: boolean }) => !gap.topologyKnown),
    ).toBe(true);
    expect(
      await reads.ensureAnchor(
        "restore",
        1,
        { turnId: "turn-20", itemId: itemId(20, 0) },
        generation,
      ),
    ).toBe("ready");
    const restored = (await services.snapshot()).projects[0].state.threads.thread;
    expect(
      restored.turns.find((turn: { id: string }) => turn.id === "turn-20").items[0].historySource
        .itemId,
    ).toBe(itemId(20, 0));
    expect(restored.turns.find((turn: { id: string }) => turn.id === "turn-1").items[0].id).toBe(
      itemId(1, 0),
    );
    expect(
      restored.turns.flatMap((turn: { items: unknown[] }) => turn.items).length,
    ).toBeLessThanOrEqual(1601);
  });
  it("takes only shell state from the desktop; projects, settings, tasks and side chats come from Host", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const changed: unknown[] = [];
    page.addEventListener("areal-scheduled-tasks-changed", (event) =>
      changed.push((event as CustomEvent).detail),
    );
    const desktopState: Snapshot = {
      projects: [{ id: "alias", root: "/legacy", models: [{ id: "legacy-model" }] }],
      library: { settings: { busyEnter: "steer", httpProxy: "http://proxy.test" } },
      power: { enabled: true, active: false, error: null },
    };
    const desktop: PlatformServices = {
      snapshot: async () => desktopState,
      onState: () => () => {},
      chooseProject: async () => null,
      command: async () => {
        throw new Error("Native write invoked");
      },
      theme: async () => ({ dark: true, id: "dark" }),
      onTheme: () => () => {},
      preview: async () => {
        throw new Error("Native preview invoked");
      },
    };
    const side = {
      id: "side",
      conversation: {
        kind: "side",
        policy: { kind: "sideExecutableV2" },
        origin: { sourceThreadId: "thread" },
      },
      turns: [],
      desktop: {
        queue: { revision: 1, items: [] },
        interactions: [],
        interactionRevision: 2,
      },
    };
    const taskRow = {
      id: "task",
      projectId: "alias",
      revision: 1,
      mode: "scheduled",
      threadId: "task-anchor",
      latestRun: { id: "run", threadId: "run-thread", status: "completed" },
    };
    const wire = transport(observation, undefined, {
      projects: [{ ...project, taskRevision: "c:1" }],
      navigation: [{ ...navigation, settings: { busyEnter: "queue", fileOpenTarget: "zed" } }],
    });
    const reads: { method: string; params: Record<string, unknown> }[] = [];
    const factory: NonNullable<HostClientOptions["transport"]> = async (lifecycle) => {
      const base = await wire.factory(lifecycle);
      return {
        ...base,
        identity: { ...base.identity, writeMethods: ["tasks.read", "desktop.command"] },
        transport: {
          ...base.transport,
          async request(method, params, context) {
            if (method === "session.watch")
              return {
                ...identity,
                subscriptionId: "side-subscription",
                ...context,
                threadId: params.threadId,
                snapshot: { thread: side },
              };
            return base.transport.request(method, params, context);
          },
          async write(method, params) {
            reads.push({ method, params });
            if (method === "tasks.read")
              return { data: [taskRow], errors: [], owners: [], hasMore: false };
            throw new Error(`Unexpected ${method}`);
          },
        },
      };
    };
    const services = createHostReadServices(desktop, options(factory));
    try {
      await until(services);
      await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
      await vi.waitFor(async () =>
        expect((await services.snapshot()).projects[0].state.tasks?.task).toBeDefined(),
      );
      let snapshot = await services.snapshot();
      expect(snapshot.power).toEqual(desktopState.power);
      expect(snapshot.projects[0].root).toBe("/canonical");
      expect(snapshot.projects[0].models).toEqual([]);
      expect(snapshot.library?.settings).toMatchObject({
        busyEnter: "queue",
        fileOpenTarget: "zed",
        httpProxy: "http://proxy.test",
      });
      expect(snapshot.library?.settings.sidebarSort).toBe("manual");
      expect(snapshot.projects[0].state.tasks.task.runs).toEqual([taskRow.latestRun]);
      expect(reads[0]).toMatchObject({
        method: "tasks.read",
        params: { operation: "observe" },
      });
      // 任务运行对话按任务目录定位到所在项目，打开时走同一 Host 会话。
      await services.reads!.selectSession({ projectId: "alias", threadId: "run-thread" });
      expect(wire.requests.at(-1)).toMatchObject({
        method: "session.open",
        context: { projectId: "canonical" },
        params: { threadId: "run-thread" },
      });
      await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
      const stop = services.reads!.watch!({ projectId: "alias", threadId: "side" });
      await vi.waitFor(async () =>
        expect((await services.snapshot()).projects[0].state.threads.side).toBeDefined(),
      );
      snapshot = await services.snapshot();
      expect(snapshot.projects[0].state.threads.side).toMatchObject(side);
      expect(snapshot.projects[0].state.threads.thread.name).toBe("Host thread");
      expect(snapshot.projects[0].state.queues.side).toEqual(side.desktop.queue);
      expect(snapshot.projects[0].state.interactions.side).toEqual({ revision: 2, data: [] });
      wire.send({
        event: "session.updated",
        ...connection,
        subscriptionId: "side-subscription",
        projectId: "canonical",
        serviceGeneration: "core-gen",
        threadId: "side",
        view: "conversation",
        sequence: 1,
        patch: { turns: [], order: [], head: { thread: { ...side, name: "Side renamed" } } },
      });
      expect((await services.snapshot()).projects[0].state.threads.side.name).toBe("Side renamed");
      // 主会话的事件不会误改侧边讨论。
      expect((await services.snapshot()).projects[0].state.threads.thread.name).toBe("Host thread");
      stop();
      expect((await services.snapshot()).projects[0].state.threads.side).toBeUndefined();
      expect(wire.requests.at(-1)).toMatchObject({
        method: "subscription.close",
        params: { subscriptionId: "side-subscription" },
      });
      // Host 每次任务更新换标记；换了才重读，并通知打开的任务视图。
      wire.send({
        event: "shell.updated",
        ...connection,
        subscriptionId: "shell",
        sequence: 1,
        delta: {
          projects: { upsert: [{ ...project, taskRevision: "c:2" }], remove: [] },
          navigation: { upsert: [], remove: [] },
        },
      });
      await vi.waitFor(() => expect(changed).toEqual(["alias"]));
      expect(reads.filter((read) => read.method === "tasks.read")).toHaveLength(2);
      // 只有登记为桌面专属的操作（系统文件框选插件包等）仍走桌面通道。
      await expect(
        services.command("manage", { projectId: "alias", operation: "pluginArchivePick" } as never),
      ).rejects.toThrow("Native write invoked");
    } finally {
      page.dispatchEvent(new Event("pagehide"));
      vi.unstubAllGlobals();
    }
  });
  it("preserves native history source identities, media and opaque cursor", async () => {
    const wire = transport();
    const services = createHostReadServices(undefined, options(wire.factory));
    await until(services);
    await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
    await services.reads!.loadOlder();
    const thread = (await services.snapshot()).projects[0].state.threads.thread;
    expect(thread.turns[0].items[0].historySource).toEqual({
      threadId: "original-thread",
      turnId: "original-turn",
      itemId: "original-item",
    });
    expect(thread.turns[0].items[0].content[0].media).toEqual({ uri: "core://native/media" });
    expect(thread.turns[1].items[0].arguments).toEqual({ native: [1, 2] });
    expect(thread.displayHistory.complete).toBe(true);
    expect(
      wire.requests.find((request) => request.method === "session.history")?.params,
    ).toMatchObject({ view: "own", cursor: "native-older" });
    expect(services.capabilities).toEqual({
      mutations: false,
      conversationSubmit: false,
      conversationCreate: false,
      native: false,
      library: false,
      taskCatalog: false,
      taskManage: false,
      pages: false,
      settings: [],
    });
    expect(wire.requests.map((request) => request.method)).toEqual([
      "shell.subscribe",
      "session.open",
      "session.history",
    ]);
  });
  it("rejects a deferred fragment with a different native body version", async () => {
    const text = JSON.stringify(entry),
      totalBytes = new TextEncoder().encode(text).length;
    const native = {
      thread: {
        id: "thread",
        turns: [
          {
            id: "turn",
            items: [
              {
                id: "original-item",
                type: "historyDeferred",
                originalType: "userMessage",
                cursor: "body",
                version: "expected",
                totalBytes,
              },
            ],
          },
        ],
      },
      history: { snapshotId: "history", complete: true, nextCursor: null },
    };
    const wire = transport(native, () => ({
      snapshotId: "history",
      complete: true,
      nextCursor: null,
      data: [
        {
          sourceThreadId: entry.sourceThreadId,
          sourceTurnId: entry.sourceTurnId,
          sourceItemId: entry.sourceItemId,
          sourceTurnStatus: entry.sourceTurnStatus,
          fragment: {
            text,
            offsetUtf8: 0,
            nextOffsetUtf8: totalBytes,
            totalBytes,
            version: "WRONG",
          },
        },
      ],
    }));
    const services = createHostReadServices(undefined, options(wire.factory));
    await until(services);
    await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
    await expect(services.reads!.loadItem("original-item")).rejects.toThrow("fragment identity");
    expect(
      (await services.snapshot()).projects[0].state.threads.thread.turns[0].items[0].type,
    ).toBe("historyDeferred");
  });
  it("uses the requested GUI source instead of another source's preferences", async () => {
    const other = {
      ...navigation,
      sourceId: "other",
      projects: { alias: { title: "Other profile" } },
    };
    const wire = transport(observation, undefined, {
      projects: [project],
      navigation: [other, navigation],
    });
    const services = createHostReadServices(undefined, {
      ...options(wire.factory),
      preferredSourceId: "source",
    });
    await until(services);
    expect((await services.snapshot()).library?.projects.alias.title).toBe("Host project title");
    const unknown = createHostReadServices(undefined, options(wire.factory));
    await until(unknown);
    expect((await unknown.snapshot()).library?.projects).toEqual({});
    expect((await unknown.snapshot()).library?.settings).toEqual({});
    expect((await unknown.snapshot()).projects[0].id).toBe("canonical");
  });
  it("folds Worktree sessions into the logical project and reads their execution Core", async () => {
    const execution = {
      ...project,
      projectId: "execution",
      logicalProjectId: "canonical",
      alias: { sourceId: "source", projectId: "execution-alias" },
      serviceGeneration: "execution-gen",
      workspace: "/worktree",
      worktree: {
        state: "ready",
        directory: "/worktree",
        checkoutRoot: "/worktree",
        branch: "feature",
        base: "main",
        sourceRoot: "/canonical",
        requestId: "request",
        automatic: true,
      },
    };
    const shell = {
      projects: [{ ...project, summaries: { state: "fresh", items: [] } }, execution],
      navigation: [
        {
          ...navigation,
          bindings: [
            ...navigation.bindings,
            { projectId: "execution", alias: "execution-alias", projectless: false },
          ],
        },
      ],
    };
    const wire = transport(observation, undefined, shell);
    const services = createHostReadServices(undefined, options(wire.factory));
    await until(services);
    expect((await services.snapshot()).projects.map((project) => project.id)).toEqual(["alias"]);
    await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
    expect(wire.requests.find((request) => request.method === "session.open")?.context).toEqual({
      projectId: "execution",
      serviceGeneration: "execution-gen",
    });
    const thread = (await services.snapshot()).projects[0].state.threads.thread;
    expect(thread.executionRoot).toBe("/worktree");
    expect(thread.worktree.branch).toBe("feature");
  });
  it("retains unrelated project projections during a native session delta", async () => {
    const other = {
      ...project,
      projectId: "other",
      alias: { sourceId: "source", projectId: "other-alias" },
      workspace: "/other",
    };
    const wire = transport(observation, undefined, {
      projects: [project, other],
      navigation: [navigation],
    });
    const services = createHostReadServices(undefined, options(wire.factory));
    await until(services);
    await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
    const previous = (await services.snapshot()).projects[1];
    wire.send({
      ...identity,
      event: "session.updated",
      sequence: 1,
      patch: {
        turns: [
          {
            id: "latest-turn",
            items: [
              {
                id: "latest-item",
                value: { id: "latest-item", type: "agentMessage", text: "changed" },
              },
            ],
          },
        ],
      },
    });
    const next = await services.snapshot();
    expect(next.projects[1]).toBe(previous);
    expect(next.projects[0].state.threads.thread.turns[0].items[0].text).toBe("changed");
  });
  it("routes complete conversation inputs and preserves unknown drafts without replay", async () => {
    const wire = transport({
      ...observation,
      thread: { ...observation.thread, desktop: { configuration: { revision: 7 } } },
    });
    const writes: Array<{
      method: string;
      params: Record<string, unknown>;
      projectId?: string;
      commandId?: string;
    }> = [];
    let admissionState = "accepted";
    const factory: NonNullable<HostClientOptions["transport"]> = async (lifecycle) => {
      const opened = await wire.factory(lifecycle);
      return {
        ...opened,
        identity: {
          ...opened.identity,
          writeMethods: ["session.create", "session.send", "session.control", "command.read"],
        },
        transport: {
          ...opened.transport,
          async write(method, params, context, commandId) {
            writes.push({ method, params, projectId: context?.projectId, commandId });
            return {
              admissionState,
              commandId: method === "command.read" ? params.commandId : commandId,
              method: method === "command.read" ? "session.send" : method,
              target: { threadId: "thread" },
              threadId: "thread",
              turnId: "turn",
              nativeRequestId: commandId,
            };
          },
        },
      };
    };
    const services = createHostReadServices(undefined, options(factory));
    await until(services);
    await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
    const { call } = await import("./services.js");
    const requestId = "11111111-1111-4111-8111-111111111111";
    const creation = {
      projectId: "alias",
      requestId,
      model: { providerId: "provider", modelId: "model" },
      parameters: { reasoningEffort: "high" },
      options: { permissionPreset: "ask" as const },
      worktree: { mode: "source" as const },
    };
    expect(await call(services, "create", creation)).toEqual({ threadId: "thread", requestId });
    expect(writes.at(-1)).toMatchObject({
      method: "session.create",
      projectId: "canonical",
      commandId: requestId,
      params: {
        model: creation.model,
        parameters: creation.parameters,
        options: creation.options,
        worktree: creation.worktree,
      },
    });
    expect(writes.at(-1)?.params).not.toHaveProperty("projectId");
    const message = {
      projectId: "alias",
      threadId: "thread",
      text: "continue",
      attachments: [{ type: "file" as const, url: "areal://blob/test", mimeType: "text/plain" }],
      conversationQuotes: [{ text: "quoted" }],
      mcpContent: [{ type: "text" as const, text: "app content" }],
      expectedTurnId: "turn",
      enqueue: true,
    };
    expect(await call(services, "send", message)).toEqual({ threadId: "thread", turnId: "turn" });
    expect(writes.at(-1)).toMatchObject({
      method: "session.send",
      projectId: "canonical",
      params: {
        expectedConfigRevision: 7,
        attachments: message.attachments,
        conversationQuotes: message.conversationQuotes,
        mcpContent: message.mcpContent,
      },
    });
    // 立即发还是排队由 Host 决定；界面不再替它断言当前轮次。
    expect(writes.at(-1)?.params).not.toHaveProperty("enqueue");
    expect(writes.at(-1)?.params).not.toHaveProperty("expectedTurnId");
    await call(services, "steer", message);
    expect(writes.at(-1)).toMatchObject({
      method: "session.control",
      params: {
        operation: "steer",
        values: {
          expectedTurnId: "turn",
          attachments: message.attachments,
          conversationQuotes: message.conversationQuotes,
          mcpContent: message.mcpContent,
        },
      },
    });
    admissionState = "pending";
    const before = writes.length;
    const unknown = await call(services, "send", message).catch((error: unknown) => error);
    expect(unknown).toMatchObject({
      submissionUnknown: true,
      requestId: expect.any(String),
      outcome: {
        kind: "unconfirmed",
        operation: { method: "turn/start", target: { kind: "thread", threadId: "thread" } },
      },
    });
    expect(writes).toHaveLength(before + 1);
    const original = unknown as Error & {
      requestId: string;
      outcome: { operation: import("./recoveryPresentation.js").RecoveryOperation };
    };
    await call(services, "reconcile", { projectId: "alias", requestId: original.requestId });
    expect(
      recoveredOutcome(
        (await services.snapshot()).projects[0],
        original.requestId,
        "thread",
        original.outcome.operation,
      ),
    ).toBeUndefined();
    admissionState = "accepted";
    await call(services, "reconcile", { projectId: "alias", requestId: original.requestId });
    const reconciled = (await services.snapshot()).projects[0];
    expect(
      recoveredOutcome(reconciled, original.requestId, "thread", original.outcome.operation),
    ).toMatchObject({ accepted: true, status: "completed" });
    expect(writes.at(-1)).toMatchObject({
      method: "command.read",
      params: { commandId: original.requestId },
    });
    expect(writes.filter((write) => write.method === "session.send")).toHaveLength(2);
    expect(services.capabilities).toMatchObject({
      mutations: false,
      conversationSubmit: true,
      conversationCreate: true,
    });
  });

  it("routes stop and approvals through Host receipts and falls back only when Host declines", async () => {
    const pending = {
      threadId: "thread",
      requestId: "approval",
      turnId: "latest-turn",
      kind: "approval",
      status: "pending",
      argumentsDigest: "a".repeat(64),
    };
    const native = {
      ...observation,
      thread: { ...observation.thread, desktop: { interactions: [pending] } },
    };
    const wire = transport(native);
    const writes: { method: string; params: Record<string, unknown>; commandId?: string }[] = [];
    let stopReply: unknown = { admissionState: "accepted" };
    const factory: NonNullable<HostClientOptions["transport"]> = async (lifecycle) => {
      const opened = await wire.factory(lifecycle);
      return {
        identity: {
          ...opened.identity,
          writeMethods: ["turn.stop", "interaction.respond", "attention.read"],
        },
        transport: {
          ...opened.transport,
          async write(method, params, _context, commandId) {
            writes.push({ method, params, commandId });
            if (method === "attention.read")
              return params.cursor
                ? { reviewToken: "token", argumentsDigest: "b".repeat(64) }
                : { nextCursor: "more" };
            if (method === "turn.stop" && stopReply instanceof Error) throw stopReply;
            return method === "turn.stop" ? stopReply : { admissionState: "accepted" };
          },
        },
      };
    };
    // 只核对是否退回桌面路径；桌面回执结构由桌面契约测试覆盖。
    const native_ = vi.fn(async () => ({ ok: false as const, error: { message: "desktop path" } }));
    const desktop: PlatformServices = {
      snapshot: async () => ({ projects: [] }),
      onState: () => () => {},
      chooseProject: async () => null,
      command: native_ as PlatformServices["command"],
      theme: async () => ({ dark: true, id: "dark" }),
      onTheme: () => () => {},
      preview: async () => ({}),
    };
    const services = createHostReadServices(desktop, options(factory));
    await until(services);
    await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
    const { call } = await import("./services.js");
    const stop = {
      projectId: "alias",
      threadId: "thread",
      turnId: "latest-turn",
      requestId: "11111111-1111-4111-8111-111111111111",
    };
    await call(services, "stop", stop);
    expect(writes.at(-1)).toMatchObject({
      method: "turn.stop",
      params: { threadId: "thread", expectedTurnId: "latest-turn" },
    });
    expect(native_).not.toHaveBeenCalled();
    stopReply = { admissionState: "unknown", commandId: "lost" };
    await expect(call(services, "stop", stop)).rejects.toMatchObject({ submissionUnknown: true });
    expect(native_).not.toHaveBeenCalled();
    stopReply = Object.assign(new Error("workflow"), { code: "TASK_CONTROL_REQUIRED" });
    await expect(call(services, "stop", stop)).rejects.toThrow("desktop path");
    expect(native_).toHaveBeenCalledTimes(1);
    await call(services, "respond", {
      projectId: "alias",
      threadId: "thread",
      requestId: "approval",
      decision: "allowSession",
    });
    expect(writes.at(-1)).toMatchObject({
      method: "interaction.respond",
      params: {
        threadId: "thread",
        turnId: "latest-turn",
        interactionId: "approval",
        decision: "allowSession",
        argumentsDigest: "b".repeat(64),
        reviewToken: "token",
      },
    });
    expect(writes.filter((entry) => entry.method === "attention.read")).toHaveLength(2);
    expect(native_).toHaveBeenCalledTimes(1);
  });
});
