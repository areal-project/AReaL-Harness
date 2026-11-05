import { describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostClientOptions } from "@areal/client";
import { createHostReadServices } from "./host-services.js";
import type { Action, PlatformServices, Snapshot } from "./services.js";
import { PlatformReadProvider } from "./PlatformReadContext.js";
import { useConversationHistory } from "./ConversationHistory.js";
import { draftModelOptions, draftModelSelection } from "./lib/draftModelSelection.js";
import { resolveDraftProfile } from "./ProfileDetails.js";
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
};
const navigation = {
  sourceId: "source",
  preferences: { sidebarSort: "manual" },
  state: "available",
  bindings: [{ projectId: "canonical", alias: "alias", projectless: false }],
  projects: { alias: { title: "Host project title" } },
  threads: {},
  projectOrder: ["alias"],
  sections: [],
  sidebarThreadOrder: [],
  sidebarRevision: 1,
};
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
  shell = { projects: [project], navigation: [navigation] },
) {
  const requests: {
    method: string;
    params: Record<string, unknown>;
    context?: { projectId: string; serviceGeneration: string };
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
  it("replaces legacy lists and conversations while retaining write catalogs and native commands", async () => {
    const wire = transport();
    const legacy: Snapshot = {
      projects: [
        {
          id: "alias",
          root: "/legacy",
          models: [{ id: "legacy-model" }],
          profiles: [{ id: "legacy-profile" }],
          state: { threads: { thread: { id: "thread", name: "WRONG LEGACY", turns: [] } } },
          summaries: [{ id: "wrong" }],
        },
        { id: "legacy-only" },
      ],
      library: {
        settings: { sidebarSort: "priority", unmigratedPreference: "retained" },
        projects: { alias: { title: "WRONG LEGACY" } },
      },
    };
    const desktop: PlatformServices = {
      snapshot: async () => legacy,
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
    const services = createHostReadServices(desktop, options(wire.factory));
    await until(services);
    await services.reads!.selectSession({ projectId: "alias", threadId: "thread" });
    const snapshot = await services.snapshot();
    expect(snapshot.projects.map((project) => project.id)).toEqual(["alias"]);
    expect(snapshot.projects[0].root).toBe("/canonical");
    expect(snapshot.projects[0].models).toEqual([{ id: "legacy-model" }]);
    expect(snapshot.projects[0].profiles).toEqual([{ id: "legacy-profile" }]);
    expect(snapshot.projects[0].summaries[0].name).toBe("Host title");
    expect(snapshot.projects[0].state.threads.thread.name).toBe("Host thread");
    expect(snapshot.library?.projects.alias.title).toBe("Host project title");
    expect(snapshot.library?.settings.sidebarSort).toBe("manual");
    expect(snapshot.library?.settings.unmigratedPreference).toBe("retained");
    expect(services.command).toBe(desktop.command);
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
    expect(services.capabilities).toEqual({ mutations: false, native: false });
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
    const services = createHostReadServices(desktop, { ...options(factory), writes: true });
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
