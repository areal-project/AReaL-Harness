import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostClient, ShellProject } from "@areal/client";
import {
  modelServiceObserved,
  refreshInspections,
  refreshModelCatalogs,
} from "./host-auxiliary-reads.js";

afterEach(() => vi.useRealTimers());

describe("model catalog refresh", () => {
  it("refreshes a project catalog when another client changes its revision", async () => {
    const pending: ((value: unknown) => void)[] = [];
    const client = {
      snapshot: () => ({ connection: "ready", identity: { connectionId: "connection" } }),
      query: () => new Promise((resolve) => pending.push(resolve)),
    } as unknown as HostClient;
    const catalogs = new Map<string, { identity: string; value?: Record<string, unknown> }>();
    const project = {
      projectId: "host",
      state: "ready",
      serviceGeneration: "generation",
      modelCatalogRevision: "1",
    };
    const refresh = (revision: string) =>
      refreshModelCatalogs(
        client,
        [{ ...project, modelCatalogRevision: revision }] as unknown as ShellProject[],
        catalogs,
        () => {},
      );
    refresh("1");
    refresh("2");
    expect(pending).toHaveLength(2);
    pending[1]({ models: ["new"] });
    await Promise.resolve();
    pending[0]({ models: ["old"] });
    await Promise.resolve();
    expect(catalogs.get("host")?.value).toEqual({ models: ["new"] });
  });

  it("retries a failed read after the back-off instead of keeping the generation empty", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let fail = true;
    const client = {
      snapshot: () => ({ connection: "ready", identity: { connectionId: "connection" } }),
      query: async () => {
        calls++;
        if (fail) throw new Error("backend unavailable");
        return { models: [], profiles: [{ id: "profile" }] };
      },
    } as unknown as HostClient;
    const projects = [
      { projectId: "host", state: "ready", serviceGeneration: "generation" },
    ] as unknown as ShellProject[];
    const catalogs = new Map<string, { identity: string; value?: Record<string, unknown> }>();
    const refresh = () => refreshModelCatalogs(client, projects, catalogs, refresh);
    refresh();
    await vi.advanceTimersByTimeAsync(0);
    refresh();
    refresh();
    expect(calls).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    expect(catalogs.get("host")?.value).toMatchObject({ profiles: [{ id: "profile" }] });
    // 模型服务设置的应用状态变了：同一代也重读，重读期间旧目录还在；状态没变不重读。
    const status = (applied: boolean) => ({
      revision: "r",
      projects: [{ projectId: "p", applied }],
    });
    modelServiceObserved(client, status(false));
    modelServiceObserved(client, status(false));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    modelServiceObserved(client, status(true));
    expect(catalogs.get("host")?.value).toMatchObject({ profiles: [{ id: "profile" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3);
  });
});

it("retries a failed configuration inspection for the same revision", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const client = {
    snapshot: () => ({ connection: "ready", identity: { connectionId: "connection" } }),
    workbench: async () => {
      if (++calls === 1) throw new Error("busy");
      return { modelName: "legacy-alpha" };
    },
  } as unknown as HostClient;
  const projects = [
    {
      id: "p",
      state: {
        threads: {
          t: { desktop: { configuration: { revision: 2, defaultModelRevision: "original" } } },
        },
      },
    },
  ];
  const inspections = new Map<string, { identity: string; value?: Record<string, unknown> }>();
  const refresh = () => refreshInspections(client, projects as never, inspections, refresh);
  refresh();
  await vi.advanceTimersByTimeAsync(5000);
  expect(calls).toBe(2);
  expect(inspections.get("p:t")?.value).toEqual({ modelName: "legacy-alpha" });
});

it("does not install an inspection from an older revision or connection", async () => {
  let connectionId = "first";
  const replies: ((value: unknown) => void)[] = [];
  const client = {
    snapshot: () => ({ connection: "ready", identity: { connectionId } }),
    workbench: () => new Promise((resolve) => replies.push(resolve)),
  } as unknown as HostClient;
  const project = {
    id: "p",
    core: { serviceGeneration: "g" },
    state: { threads: { t: { desktop: { configuration: { revision: 1 } } } } },
  };
  const inspections = new Map<
    string,
    { identity: string; scope?: string; value?: Record<string, unknown> }
  >();
  const refresh = () => refreshInspections(client, [project] as never, inspections, () => {});
  refresh();
  project.state.threads.t.desktop.configuration.revision = 2;
  refresh();
  connectionId = "second";
  refresh();
  replies[0]({ modelName: "old revision" });
  replies[1]({ modelName: "old connection" });
  replies[2]({ modelName: "current" });
  await Promise.resolve();
  expect(inspections.get("p:t")?.value).toEqual({ modelName: "current" });
});
