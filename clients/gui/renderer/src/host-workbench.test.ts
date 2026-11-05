import { describe, expect, it } from "vite-plus/test";
import type { HostClient } from "@areal/client";
import { createWorkbenchRoutes } from "./host-workbench.js";
import type { PlatformServices } from "./services.js";

function setup(answer: (method: string, params: unknown) => unknown) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    writable: () => true,
    workbench: async (method: string, params: unknown) => {
      calls.push([method, params]);
      return answer(method, params);
    },
  } as unknown as HostClient;
  const desktop = {
    command: async () => ({
      ok: true,
      value: {
        since: 7,
        days: { "2026-11-04": { activeMs: 60000 }, "2026-11-05": { activeMs: 0 } },
      },
    }),
  } as unknown as PlatformServices;
  const routes = createWorkbenchRoutes(
    client,
    desktop,
    new Set(["analytics"]),
    undefined,
    undefined,
  )!;
  return { routes, calls };
}

describe("workbench routes", () => {
  it("reads analytics through Host after merging the desktop's active days", async () => {
    const { routes, calls } = setup((method) => (method === "analytics.read" ? { tokens: 1 } : {}));
    expect(await routes.call("analytics", { operation: "read" })).toEqual({ value: { tokens: 1 } });
    expect(await routes.call("tasks", { operation: "list" })).toBeUndefined();
    expect(calls[0]).toEqual([
      "analytics.import",
      { state: { version: 1, since: 7, days: { "2026-11-04": 60000 }, turns: {}, skills: {} } },
    ]);
    expect(calls.filter(([method]) => method === "analytics.import")).toHaveLength(1);
  });

  it("falls back to the desktop path when the service is unavailable", async () => {
    const { routes } = setup((method) => {
      if (method === "analytics.sync")
        throw Object.assign(new Error("down"), { code: "CAPABILITY_UNAVAILABLE" });
      return {};
    });
    expect(await routes.call("analytics", { operation: "sync" })).toBeUndefined();
  });
});
