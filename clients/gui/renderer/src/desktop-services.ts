import {
  readSnapShotState,
  readSnapShot,
  readPendingSnapShot,
  readSnapShotEvent,
} from "@areal/workbench/desktop-contract/snapshots";
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
export type {
  CommandName,
  CommandParams,
  CommandResponse,
  DesktopError,
  DesktopResult,
  McpAppDeepLink,
  NotificationTarget,
  OwnedPreviewRequest,
  PreviewRequest,
  PreviewViewport,
  QuitProgress,
  TrajectoryStatus,
} from "@areal/workbench/desktop-contract";
// 完整命令校验器包含管理协议；首次调用时加载，校验完成前不派发请求。
export async function validateCommand(
  ...args: Parameters<typeof import("@areal/workbench/desktop-contract").validateCommand>
) {
  const contract: typeof import("@areal/workbench/desktop-contract") =
    await import("@areal/workbench/desktop-contract");
  contract.validateCommand(...args);
}
export async function validateCommandResponse(
  ...args: Parameters<typeof import("@areal/workbench/desktop-contract").validateCommandResponse>
) {
  const contract: typeof import("@areal/workbench/desktop-contract") =
    await import("@areal/workbench/desktop-contract");
  contract.validateCommandResponse(...args);
}
export type { ObservedCatalogOwner } from "@areal/workbench/desktop-contract/catalog";
export type {
  Attachment,
  PluginCommandRef,
  SideAnchor,
  SideSelection,
} from "@areal/workbench/desktop-contract/conversation";
export {
  isRequest,
  sideAnchor,
  sideSelection,
} from "@areal/workbench/desktop-contract/conversation";
export type { SidebarItem } from "@areal/workbench/desktop-contract/library-media";
export { readLibraryRequest } from "@areal/workbench/desktop-contract/library-media";
export type {
  ManagementRequest,
  ManagementRequestMap,
  ManagementResponse,
  ManagementResponseMap,
  PluginMutation,
  PluginStoreOperation,
} from "@areal/workbench/desktop-contract/management";
export { generationStats, modelUsage } from "@areal/workbench/desktop-contract/management-context";
export {
  validateMcpPageCall,
  validateMcpPageDeclaration,
  validateMcpPageReply,
} from "@areal/workbench/desktop-contract/mcp-page";
export type {
  ChatGPTStatus,
  DiscoveryConnection,
  ModelParameters,
} from "@areal/workbench/desktop-contract/provider";
export type { Hook, ResourceRequest, Scope } from "@areal/workbench/desktop-contract/resource";
export { modelRecord } from "@areal/workbench/desktop-contract/shared";
export type {
  DesktopSnapShot,
  DesktopSnapShotState,
  SnapShotModifier,
  SnapShotServices,
  SnapShotSettings,
  SnapShotShortcut,
  SnapShotSource,
} from "@areal/workbench/desktop-contract/snapshots";
export {
  isModifierPairShortcut,
  isSnapShotSource,
  readSnapShotSettings,
  snapShotShortcutModifierPair,
} from "@areal/workbench/desktop-contract/snapshots";
export { commandResponseError } from "@areal/workbench/desktop-contract/transport";
export type { WorktreeOptions } from "@areal/workbench/desktop-contract/workspace";

export function initializeDesktopServices(
  getLocale: () => string,
  subscribeLocale: (listener: () => void) => () => void,
): PlatformServices | undefined {
  const bridge = (window as unknown as { arealDesktop?: DesktopBridge }).arealDesktop;
  if (!bridge) return undefined;
  const syncNativeLocale = () => bridge.setInterfaceLocale(getLocale());
  const unsubscribeLocale = subscribeLocale(syncNativeLocale);
  syncNativeLocale();
  window.addEventListener("pagehide", unsubscribeLocale, { once: true });
  return createDesktopServices(bridge);
}

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
  const snapShots: PlatformServices["snapShots"] = bridge.getSnapShotState
    ? {
        getSnapShotState: async () => readSnapShotState(await bridge.getSnapShotState!()),
        requestSnapShotPermissions: async (value) => {
          await bridge.requestSnapShotPermissions!(value);
        },
        setupSnapShot: async (value) => {
          await bridge.setupSnapShot!(value);
        },
        captureSnapShot: async () => {
          await bridge.captureSnapShot!();
        },
        checkSnapShotShortcut: async (value) => {
          const result = await bridge.checkSnapShotShortcut!(value);
          if (
            !result ||
            typeof result !== "object" ||
            !("available" in result) ||
            typeof result.available !== "boolean" ||
            !("message" in result) ||
            !(result.message === null || typeof result.message === "string")
          )
            throw new Error("Invalid SnapShot shortcut availability");
          return { available: result.available, message: result.message };
        },
        setSnapShotShortcutSuppressed: async (value) => {
          await bridge.setSnapShotShortcutSuppressed!(value);
        },
        listPendingSnapShots: async () => {
          const value = await bridge.listPendingSnapShots!();
          if (!Array.isArray(value)) throw new Error("Invalid pending SnapShots");
          return value.map(readPendingSnapShot);
        },
        readSnapShot: async (id) => readSnapShot(await bridge.readSnapShot!(id)),
        setSnapShotAnimationDestination: async (value) => {
          await bridge.setSnapShotAnimationDestination!(value);
        },
        dismissSnapShotAnimation: async (id) => {
          await bridge.dismissSnapShotAnimation!(id);
        },
        acknowledgeSnapShot: async (id) => {
          await bridge.acknowledgeSnapShot!(id);
        },
        onSnapShotEvent: (listener) =>
          bridge.onSnapShotEvent!((value) => listener(readSnapShotEvent(value))),
      }
    : undefined;
  return {
    getHostTicket: bridge.getHostTicket,
    snapShots,
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
    ...(bridge.openExternal && {
      openExternal: async (url: string) => {
        await bridge.openExternal!(url);
      },
    }),
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
