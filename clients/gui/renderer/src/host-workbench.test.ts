import { describe, expect, it } from "vite-plus/test";
import type { HostClient } from "@areal/client";
import { call } from "./services.js";
import {
  createWorkbenchRoutes,
  hostDesktopCommand,
  hostPlatformCapabilities,
} from "./host-workbench.js";
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
    () => "fixture",
  )!;
  return { routes, calls };
}

describe("workbench routes", () => {
  it("keeps native process controls with the desktop connection owner", async () => {
    const client = {
      writable: () => true,
      workbench: async () => {
        throw new Error("Native process reached the public Host manage route");
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      {} as PlatformServices,
      new Set(["manage"]),
      undefined,
      undefined,
      () => "fixture",
    )!;
    for (const operation of [
      "processStart",
      "processSubmission",
      "processOutput",
      "processWrite",
      "processResize",
      "processTerminate",
    ]) {
      expect(
        await routes.call("manage", {
          operation,
          projectId: "project",
          threadId: "thread",
          id: "process",
          ...(operation === "processStart" || operation === "processSubmission"
            ? { guiOwned: true }
            : {}),
        }),
      ).toBeUndefined();
    }
  });

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

describe("library routes without a desktop adapter", () => {
  const state = {
    projects: {},
    threads: {},
    projectOrder: [],
    sections: [{ id: "inbox", title: "Inbox" }],
    sidebarThreadOrder: [],
    sidebarRevision: 1,
    settings: {},
  };
  function library(answer: (commandId: string) => unknown) {
    const commands: string[] = [];
    const client = {
      writable: () => true,
      workbench: async (_method: string, _params: unknown, commandId: string) => {
        commands.push(commandId);
        return answer(commandId);
      },
    } as unknown as HostClient;
    return {
      commands,
      routes: createWorkbenchRoutes(
        client,
        undefined,
        new Set(["library"]),
        undefined,
        undefined,
        () => "fixture",
      )!,
    };
  }

  it("returns a confirmed receipt and leaves unrelated commands to their owner", async () => {
    const { routes, commands } = library((commandId) => ({
      commandId,
      method: "library.command",
      admissionState: "accepted",
      submissionUnknown: false,
      receipt: state,
    }));
    expect(
      await call({ workbench: routes } as PlatformServices, "library", {
        operation: "createSection",
        title: "Inbox",
      }),
    ).toEqual(state);
    expect(await routes.call("library", { operation: "settings" })).toBeUndefined();
    expect(commands).toHaveLength(1);
  });

  it("routes navigation preferences but does not expose native library settings", async () => {
    const { routes, commands } = library((commandId) => ({
      commandId,
      method: "library.command",
      admissionState: "accepted",
      submissionUnknown: false,
      receipt: state,
    }));
    expect(
      await routes.call("library", { operation: "settings", key: "sidebarSort", value: "manual" }),
    ).toEqual({ value: state });
    expect(
      await routes.call("library", {
        operation: "settings",
        key: "computerControlEnabled",
        value: true,
      }),
    ).toBeUndefined();
    expect(commands).toHaveLength(1);
  });

  it("keeps a definite rejection distinct from an unknown result without retrying", async () => {
    const { routes, commands } = library(() => {
      throw Object.assign(new Error("Denied"), { code: "FORBIDDEN", submissionUnknown: false });
    });
    await expect(
      routes.call("library", { operation: "createSection", title: "Inbox" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", submissionUnknown: false });
    expect(commands).toHaveLength(1);
  });

  it.each([null, {}, { submissionUnknown: false }, { submissionUnknown: true }])(
    "does not report an invalid or unconfirmed receipt as success: %j",
    async (receipt) => {
      const { routes, commands } = library(() => receipt);
      await expect(
        routes.call("library", { operation: "createSection", title: "Inbox" }),
      ).rejects.toMatchObject({ submissionUnknown: true });
      expect(commands).toHaveLength(1);
    },
  );
});

describe("Worktree Host routing", () => {
  it("preserves the domain request ID and validates the result through the shared workspace contract", async () => {
    const calls: Array<{ method: string; params: unknown; commandId?: string }> = [];
    const settings = {
      worktreeRoot: "/isolated/worktrees",
      branchPrefix: "web",
      fetchBeforeCreate: false,
      autoCleanup: false,
      keepCount: 10,
    };
    const client = {
      writable: () => true,
      workbench: async (method: string, params: unknown, commandId?: string) => {
        calls.push({ method, params, commandId });
        return {
          commandId,
          method,
          admissionState: "accepted",
          submissionUnknown: false,
          receipt: settings,
        };
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["worktree"]),
      undefined,
      undefined,
      () => "source",
    )!;
    expect(
      await call({ workbench: routes } as PlatformServices, "workspace", {
        operation: "worktreeSettings",
        worktreeRoot: settings.worktreeRoot,
        branchPrefix: "web",
        expectedRevision: 3,
      }),
    ).toEqual(settings);
    expect(calls[0].params).toMatchObject({ sourceId: "source", expectedRevision: 3 });
    expect(calls[0].commandId).toMatch(/^[a-f0-9-]{36}$/);
    expect(await routes.call("workspace", { operation: "gitPush" })).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("does not replay a lost Worktree creation or discard its original request ID", async () => {
    const calls: unknown[] = [];
    const client = {
      writable: () => true,
      workbench: async (_method: string, params: unknown) => {
        calls.push(params);
        throw new Error("Connection lost");
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["worktree"]),
      undefined,
      undefined,
      () => "source",
    )!;
    await expect(
      routes.call("workspace", {
        operation: "worktreeCreate",
        projectId: "p",
        requestId: "original",
      }),
    ).rejects.toMatchObject({ submissionUnknown: true });
    expect(calls).toEqual([
      { sourceId: "source", operation: "worktreeCreate", projectId: "p", requestId: "original" },
    ]);
  });
});

describe("task directory Host routing", () => {
  const catalog = {
    data: [],
    errors: [],
    hasMore: false,
    owners: [
      {
        projectId: "project",
        status: "unobserved",
        source: "published",
        coverage: { kind: "empty" },
        readAt: 1,
      },
    ],
    source: "published",
    executionState: "unobserved",
  };

  it("preserves preview identity and uses the shared response validator", async () => {
    const requests: unknown[] = [];
    let response: unknown = catalog;
    const client = {
      writable: () => true,
      workbench: async (method: string, params: unknown) => {
        requests.push([method, params]);
        return response;
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["tasks"]),
      undefined,
      undefined,
      () => "source",
    )!;
    const params = {
      operation: "preview" as const,
      projectId: "project",
      requestId: crypto.randomUUID(),
      viewEpoch: 4,
      limit: 30,
    };
    response = {
      ...catalog,
      projectId: params.projectId,
      requestId: params.requestId,
      viewEpoch: params.viewEpoch,
    };
    expect(await call({ workbench: routes } as PlatformServices, "tasks", params)).toEqual(
      response,
    );
    expect(requests).toEqual([["tasks.read", { ...params, sourceId: "source" }]]);
    response = {
      ...(response as object),
      owners: [{ projectId: "project", status: "unobserved" }],
    };
    await expect(
      call({ workbench: routes } as PlatformServices, "tasks", params),
    ).rejects.toThrow();
  });

  it("does not dispatch without negotiated permission or a selected source", async () => {
    let allowed = false;
    const client = {
      writable: () => allowed,
      workbench: async () => {
        throw new Error("must not dispatch");
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["tasks"]),
      undefined,
      undefined,
      () => undefined,
    )!;
    expect(await routes.call("tasks", { operation: "preview" })).toBeUndefined();
    allowed = true;
    await expect(routes.call("tasks", { operation: "preview" })).rejects.toThrow(
      "请先选择任务目录来源",
    );
  });
});

describe("trajectory and feedback Host routing", () => {
  it("checks feedback preferences through the shared contract and preserves uncertain submissions", async () => {
    const status = {
      enabled: false,
      connected: false,
      installation: null,
      account: null,
      destination: null,
      opted_in: false,
    };
    const calls: Array<{ method: string; params: unknown; commandId?: string }> = [];
    const client = {
      writable: () => true,
      workbench: async (method: string, params: unknown, commandId?: string) => {
        calls.push({ method, params, commandId });
        if (method === "trajectory.command") throw new Error("lost reply");
        if (!commandId) return status;
        return {
          method,
          commandId,
          admissionState: "accepted",
          submissionUnknown: false,
          receipt: status,
        };
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["trajectory", "feedback"]),
      undefined,
      undefined,
      () => "source",
    )!;
    const services = { workbench: routes } as PlatformServices;
    expect(await call(services, "feedback", { operation: "preference", enabled: false })).toEqual(
      status,
    );
    expect(await call(services, "feedback", { operation: "status" })).toEqual(status);
    await expect(routes.call("trajectory", { operation: "retry" })).rejects.toMatchObject({
      submissionUnknown: true,
    });
    expect(calls.map((entry) => entry.method)).toEqual([
      "feedback.command",
      "feedback.read",
      "trajectory.command",
    ]);
    expect(
      calls.every((entry) => (entry.params as { sourceId: string }).sourceId === "source"),
    ).toBe(true);
    expect(await routes.call("analytics", { operation: "read" })).toBeUndefined();
  });
});

describe("task management Host routing", () => {
  it("routes management reads without admitting picker or task submission operations", async () => {
    const requests: Array<{ method: string; params: unknown; commandId?: string }> = [];
    const client = {
      writable: () => true,
      workbench: async (method: string, params: unknown, commandId?: string) => {
        requests.push({ method, params, commandId });
        return { fixture: true };
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["manage"]),
      undefined,
      undefined,
      () => "source",
    )!;
    for (const operation of [
      "server",
      "profile",
      "skills",
      "skill",
      "plugins",
      "plugin",
      "pluginComponents",
      "pluginHooks",
      "pluginMcp",
      "processes",
      "process",
      "processWait",
      "processOutput",
      "executions",
      "execution",
      "executionWait",
      "executionTrace",
      "workgroups",
      "workgroupPolicy",
      "workgroup",
      "workgroupWait",
      "workflows",
      "workflow",
      "tasks",
      "taskInbox",
      "taskRuns",
      "taskRun",
    ]) {
      expect(await routes.call("manage", { operation, projectId: "project" })).toEqual({
        value: { fixture: true },
      });
      expect(requests.at(-1)).toEqual({
        method: "manage.read",
        params: { operation, projectId: "project", sourceId: "source" },
        commandId: undefined,
      });
    }
    const count = requests.length;
    for (const operation of ["pluginArchivePick", "taskReply", "taskCreate", "unknown"]) {
      expect(await routes.call("manage", { operation, projectId: "project" })).toBeUndefined();
    }
    expect(requests).toHaveLength(count);
  });

  it.each(["processStart", "taskRunNow", "taskResumeRun"])(
    "preserves %s request identity and does not replay an uncertain submission",
    async (operation) => {
      const requests: Array<{ method: string; params: unknown; commandId?: string }> = [];
      const client = {
        writable: () => true,
        workbench: async (method: string, params: unknown, commandId?: string) => {
          requests.push({ method, params, commandId });
          throw new Error("Connection lost");
        },
      } as unknown as HostClient;
      const routes = createWorkbenchRoutes(
        client,
        undefined,
        new Set(["manage"]),
        undefined,
        undefined,
        () => "source",
      )!;
      const input = {
        operation,
        projectId: "project",
        requestId: crypto.randomUUID(),
        ...(operation === "processStart"
          ? { threadId: "thread", argv: ["/bin/echo", "fixture"], lifetime: "turn" }
          : {
              taskId: "task",
              expectedRevision: 2,
              ...(operation === "taskResumeRun" ? { expectedRunId: "run" } : {}),
            }),
      };
      await expect(routes.call("manage", input)).rejects.toMatchObject({ submissionUnknown: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "manage.command",
        params: { ...input, sourceId: "source" },
      });
      expect(requests[0].commandId).toMatch(/^[a-f0-9-]{36}$/);
      expect(requests[0].commandId).not.toBe(input.requestId);
    },
  );

  it("returns the Core task shape for pause and resume while preserving a supplied domain request ID", async () => {
    const requests: Array<{ method: string; params: unknown; commandId?: string }> = [];
    const client = {
      writable: () => true,
      workbench: async (method: string, params: { operation: string }, commandId?: string) => {
        requests.push({ method, params, commandId });
        return {
          method,
          commandId,
          admissionState: "accepted",
          submissionUnknown: false,
          receipt: {
            id: "task",
            revision: 2,
            channelSequence: 0,
            owner: "desktop-owner",
            mode: "scheduled",
            interactionMode: "interactive",
            objective: "fixture",
            paused: params.operation === "taskPause",
            cancelled: false,
            runs: [],
            runCount: 0,
            archivedRunCount: 0,
            runsComplete: true,
            pendingQuestions: 0,
          },
        };
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["manage"]),
      undefined,
      undefined,
      () => "source",
    )!;
    const services = { workbench: routes } as PlatformServices;
    const requestId = crypto.randomUUID();
    expect(
      await call(services, "manage", {
        operation: "taskPause",
        projectId: "project",
        taskId: "task",
        expectedRevision: 1,
        requestId,
      }),
    ).toMatchObject({ paused: true });
    expect(
      await call(services, "manage", {
        operation: "taskResume",
        projectId: "project",
        taskId: "task",
        expectedRevision: 2,
      }),
    ).toMatchObject({ paused: false });
    expect(requests[0].params).toMatchObject({ requestId, sourceId: "source" });
    expect(
      requests.every((request) => request.method === "manage.command" && request.commandId),
    ).toBe(true);
    expect(await routes.call("manage", { operation: "providerSave" })).toBeUndefined();
  });
});

describe("provider Host routing", () => {
  it("keeps discovery credentials on the managed command route and never exposes revealKey", async () => {
    const calls: Array<{ method: string; params: unknown; commandId?: string }> = [];
    const client = {
      writable: () => true,
      workbench: async (method: string, params: unknown, commandId?: string) => {
        calls.push({ method, params, commandId });
        return {
          method,
          commandId,
          admissionState: "accepted",
          submissionUnknown: false,
          receipt: { models: ["fixture"] },
        };
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["providers"]),
      undefined,
      undefined,
      () => "source",
    )!;
    const request = {
      operation: "discover",
      connection: {
        baseUrl: "https://example.invalid",
        protocol: "responses",
        credential: { kind: "draft", value: "synthetic-key" },
      },
    };
    expect(await routes.call("providers", request)).toEqual({ value: { models: ["fixture"] } });
    expect(calls[0]).toMatchObject({
      method: "providers.command",
      params: { ...request, sourceId: "source" },
    });
    expect(calls[0].commandId).toBeTruthy();
    expect(
      await routes.call("providers", {
        operation: "revealKey",
        id: "provider",
        expectedRevision: "revision",
      }),
    ).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("MCP Apps catalog without a desktop adapter", () => {
  it("routes the normal manage directory action through pages without command submission", async () => {
    const calls: unknown[][] = [];
    const catalog = { data: [{ serverId: "fixture" }], requestEpoch: "epoch" };
    const client = {
      writable: () => true,
      workbench: async (...args: unknown[]) => {
        calls.push(args);
        return catalog;
      },
    } as unknown as HostClient;
    const routes = createWorkbenchRoutes(
      client,
      undefined,
      new Set(["pages"]),
      undefined,
      undefined,
      () => undefined,
    )!;
    expect(
      await routes.call("manage", {
        operation: "mcpApps",
        projectId: "project",
        threadId: "thread",
      }),
    ).toEqual({ value: catalog });
    expect(calls).toEqual([
      ["pages.command", { operation: "catalog", projectId: "project", threadId: "thread" }],
    ]);
    expect(
      await routes.call("manage", { operation: "mcpForms", projectId: "project" }),
    ).toBeUndefined();
  });
});

describe("local web desktop commands", () => {
  it("forwards only listed commands and opens desktop settings except computer control", async () => {
    const calls: unknown[] = [];
    const client = {
      writable: () => true,
      workbench: async (method: string, params: { request: { fail?: boolean } }) => {
        calls.push([method, params]);
        if (params.request.fail) throw Object.assign(new Error("Core refused"), { code: "x" });
        return { done: true };
      },
    } as unknown as HostClient;
    const command = hostDesktopCommand(client, () => "source");
    expect(await command("list", { projectId: "p" })).toEqual({ ok: true, value: { done: true } });
    expect(await command("list", { fail: true } as never)).toEqual({
      ok: false,
      error: { code: "COMMAND_FAILED", message: "Core refused" },
    });
    await expect(command("computerControl", {} as never)).rejects.toThrow("需要桌面应用");
    expect(calls[0]).toEqual([
      "desktop.command",
      { sourceId: "source", command: "list", request: { projectId: "p" } },
    ]);
    const capabilities = hostPlatformCapabilities(client, undefined, new Set(), "source");
    expect(capabilities?.mutations).toBe(true);
    expect(capabilities?.settings).toContain("模型服务");
    expect(capabilities?.settings).not.toContain("电脑控制");
    expect(hostPlatformCapabilities(client, undefined, new Set(), undefined)?.mutations).toBe(
      false,
    );
  });
});
