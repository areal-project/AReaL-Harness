import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HostClient, ShellProject } from "@areal/client";
import { refreshModelCatalogs } from "./host-auxiliary-reads.js";

afterEach(() => vi.useRealTimers());

describe("model catalog refresh", () => {
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
  });
});
