import { commandResponseError } from "@areal/workbench/desktop-contract/transport";
import { ProjectionReader } from "@areal/workbench/state-projection";
import type { DesktopBridge, PreviewRequest } from "@areal/workbench/desktop-contract";
import type { PlatformServices, Snapshot, Data } from "./services.js";
import {
  readCommandResult,
  readFields,
  readFileOpenResult,
  readInstallation,
  readProject,
  readProjectionMessage,
  readPreviewResult,
  readProjectlessDirectory,
  readSnapshot,
  readTaskDirectory,
  readTheme,
  readUpdateState,
} from "./desktop-response.js";
import type { McpFormOwner, McpFormResource } from "./mcp-app-services.js";
export type { DesktopBridge } from "@areal/workbench/desktop-contract";

let nativeDroppedFilePath: DesktopBridge["droppedFilePath"];

export function createDesktopServices(bridge: DesktopBridge): PlatformServices {
  nativeDroppedFilePath = bridge.droppedFilePath;
  let reader = new ProjectionReader(),
    nextRequest = 0,
    recovering = false;
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const pending = new Map<
    number,
    {
      resolve(value: Snapshot): void;
      reject(error: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function snapshot(): Promise<Snapshot> {
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Desktop snapshot timed out"));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      bridge.requestProjection(id);
    });
  }
  const unsubscribe = bridge.onProjection((raw) => {
    let value: Snapshot, requestId: number | undefined;
    try {
      const message = readProjectionMessage(raw);
      requestId = message.requestId;
      value = readSnapshot(reader.read(message.frame));
    } catch (error) {
      if (recovering) return;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
      recovering = true;
      reader = new ProjectionReader();
      void snapshot()
        .finally(() => {
          recovering = false;
        })
        .catch(() => {});
      return;
    }
    const request = requestId === undefined ? undefined : pending.get(requestId);
    if (request && requestId !== undefined) {
      pending.delete(requestId);
      clearTimeout(request.timer);
      request.resolve(value);
    }
    for (const listener of listeners) listener(value);
  });
  window.addEventListener(
    "pagehide",
    () => {
      unsubscribe();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Desktop document closed"));
      }
      pending.clear();
      listeners.clear();
    },
    { once: true },
  );
  async function preview(request: Exclude<PreviewRequest, { operation: "show" }>): Promise<Data>;
  async function preview(request: PreviewRequest): Promise<Data | null>;
  async function preview(request: PreviewRequest): Promise<Data | null> {
    const value = await bridge.preview(request);
    if (value === null && request.operation === "show") return null;
    return readPreviewResult(value);
  }
  async function mcpFormResource(
    operation: "pick",
    request: McpFormOwner,
  ): Promise<{ resources: McpFormResource[] }>;
  async function mcpFormResource(
    operation: "release",
    request: McpFormOwner & { uri: string },
  ): Promise<unknown>;
  async function mcpFormResource(
    operation: "pick" | "release",
    request: McpFormOwner & { uri?: string },
  ): Promise<unknown> {
    const { createMcpFormResourceCommand } = await import("./mcp-app-response.js");
    const command = createMcpFormResourceCommand(bridge.mcpFormResource);
    if (operation === "pick") return command(operation, request);
    if (typeof request.uri !== "string") throw new Error("Invalid form resource URI");
    return command(operation, { ...request, uri: request.uri });
  }
  return {
    snapshot,
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async presentReady() {
      await bridge.presentReady();
    },
    installCommandLineTools: async () => readInstallation(await bridge.installCommandLineTools()),
    chooseProject: async () => readProject(await bridge.chooseProject()),
    chooseTaskDirectory: async () => readTaskDirectory(await bridge.chooseTaskDirectory()),
    chooseProjectlessDirectory: async () =>
      readProjectlessDirectory(await bridge.chooseProjectlessDirectory()),
    fileOpen: async (request) => readFileOpenResult(await bridge.fileOpen(request)),
    command: async (name, params) => {
      const value = await bridge.command(name, params);
      try {
        return readCommandResult(value);
      } catch (error) {
        throw commandResponseError(name, params, error);
      }
    },
    theme: async (id) => readTheme(await bridge.theme(id)),
    onTheme: (listener) => bridge.onTheme((value) => listener(readTheme(value))),
    preview,
    onPreviewEvent: (listener) => bridge.onPreviewEvent((value) => listener(readFields(value))),
    updateState: async () => readUpdateState(await bridge.updateState()),
    downloadUpdate: async () => readUpdateState(await bridge.downloadUpdate()),
    recoverUpdateResources: async () => readUpdateState(await bridge.recoverUpdateResources()),
    onUpdate: (listener) => bridge.onUpdate((value) => listener(readUpdateState(value))),
    onQuitRequested: bridge.onQuitRequested,
    onQuitProgress: bridge.onQuitProgress,
    onNotificationOpen: bridge.onNotificationOpen,
    onMcpAppDeepLink: bridge.onMcpAppDeepLink,
    mcpApp: async (request) => {
      const { createMcpAppCommand } = await import("./mcp-app-response.js");
      return createMcpAppCommand(bridge.mcpApp)(request);
    },
    mcpFormResource,
    onMcpAppEvent(listener) {
      let active = true;
      const unsubscribe = bridge.onMcpAppEvent((value) => {
        void import("./mcp-app-response.js")
          .then(({ readMcpAppEvent }) => {
            if (active) listener(readMcpAppEvent(value));
          })
          .catch(() => {});
      });
      return () => {
        active = false;
        unsubscribe();
      };
    },
  };
}

// 仅桌面 preload 能从实际拖入的 File 解析原生路径。
export function droppedFilePath(file: File): string | null {
  const path: unknown = nativeDroppedFilePath?.(file);
  return typeof path === "string" && path.length ? path : null;
}
