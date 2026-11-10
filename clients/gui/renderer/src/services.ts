// 界面通过平台服务契约消费领域类型，桌面传输依赖留在适配器。
import type {
  CommandName,
  CommandParams,
  CommandResponse,
  DesktopResult,
  PreviewRequest,
  NotificationTarget,
  QuitProgress,
  ChatGPTStatus,
  SnapShotServices,
} from "./desktop-services.js";
import type {
  McpAppCommand,
  McpAppDeepLink,
  McpAppEvent,
  McpFormResourceCommand,
} from "./mcp-app-services.js";
export type { CommandName, CommandParams, CommandResponse, PreviewRequest };
export type {
  Attachment,
  ChatGPTStatus,
  DesktopError,
  DesktopSnapShot,
  DesktopSnapShotState,
  DiscoveryConnection,
  Hook,
  ManagementRequest,
  ManagementRequestMap,
  ManagementResponse,
  ManagementResponseMap,
  McpAppDeepLink,
  ModelParameters,
  ObservedCatalogOwner,
  OwnedPreviewRequest,
  PluginCommandRef,
  PluginMutation,
  PreviewViewport,
  ResourceRequest,
  Scope,
  SideAnchor,
  SideSelection,
  SidebarItem,
  SnapShotModifier,
  SnapShotServices,
  SnapShotSettings,
  SnapShotShortcut,
  SnapShotSource,
  TrajectoryStatus,
  WorktreeOptions,
} from "./desktop-services.js";
export {
  generationStats,
  isModifierPairShortcut,
  isRequest,
  isSnapShotSource,
  modelRecord,
  modelUsage,
  normalizeMcp,
  readLibraryRequest,
  readSnapShotSettings,
  sideAnchor,
  sideSelection,
  snapShotShortcutModifierPair,
  validateMcpPageCall,
  validateMcpPageDeclaration,
  validateMcpPageReply,
} from "./desktop-services.js";
export type Data = Record<string, any>;
export type FileOpenTargets = {
  targets: { id: string; label: string }[];
  preferred: string;
  preferredLabel: string;
};
export type FileOpenRequest =
  | { operation: "targets" }
  | { operation: "setDefault"; target: string }
  | {
      operation: "openHtml";
      projectId: string;
      threadId: string;
      path: string;
    }
  | {
      operation: "open" | "reveal" | "saveAs" | "readImage" | "readPdf";
      projectId: string;
      threadId?: string;
      path: string;
    };
export type WorkspaceImage = { mimeType: string; bytes: Uint8Array };
export type HostPrerequisite = {
  kind: "macos-command-line-tools";
  reason: "developer-tools-unavailable" | "python-unavailable";
  title: string;
  detail: string;
  installLabel: string;
  retryLabel: string;
  requestedMessage: string;
};
export interface Snapshot {
  projects: Data[];
  subscription?: ChatGPTStatus;
  desktopCapabilities?: { currentCommands: boolean };
  power?: { enabled: boolean; active: boolean; error: string | null } | null;
  menuBar?: { supported: boolean; active: boolean; error: string | null } | null;
  projectless?: { directory: string };
  revision?: number;
  connection?: {
    state: "connecting" | "ready" | "unavailable";
    message?: string;
    recovery?: "check" | "reconnect";
    prerequisite?: HostPrerequisite;
  };
  serviceSummary?: { state: "running" | "stopped" | "unknown"; busy: boolean };
  backendUpdate?: { state: "applying" | "pending" | "failed"; message?: string };
  lifecycle?: {
    recovery?: {
      canRecover: boolean;
      message: string;
      projects: { projectId: string; root: string; state: string; message: string }[];
    };
    supported: boolean;
    phase?: string;
    message?: string;
    error?: string;
    requestId?: string;
    kind?: string;
    desktopExit?: string;
    targets?: { projectId: string; phase: string; message?: string }[];
    operations: {
      requestId: string;
      kind: string;
      phase: string;
      message?: string;
      threadId?: string;
      turnId?: string;
      desktopExit?: string;
      targets: { projectId: string; phase: string; message?: string }[];
    }[];
  };
  library?: Data;
  computerControl?: Data | null;
}
export interface UpdateState {
  enabled: boolean;
  channel?: "stable" | "beta";
  status: "idle" | "available" | "downloading" | "validating" | "deferred" | "installing" | "error";
  version?: string;
  downloaded?: string;
  installing?: boolean;
  percent?: number | null;
  detail?: string;
}
export type { NotificationTarget, QuitProgress } from "./desktop-services.js";
export interface PlatformReadServices {
  status(): import("@areal/client").HostReadState;
  subscribe(listener: () => void): () => void;
  selectSession(
    target: { projectId: string; threadId: string; persisted?: boolean } | null,
  ): Promise<void>;
  history(options: {
    view: "own" | "inherited" | "reference";
    cursor?: string;
    maxBytes?: number;
  }): Promise<import("./host-services.js").HostHistoryPage>;
  media(
    source: import("@areal/client").MediaSource,
    signal?: AbortSignal,
  ): Promise<import("@areal/client").MediaBytes>;
  acquire(viewId: string, generation: string): Promise<void>;
  release(viewId: string, generation: string): Promise<void>;
  retain(
    viewId: string,
    revision: number,
    anchor: Pick<import("./readingViews.js").ReadingAnchor, "turnId" | "itemId"> | null,
    generation: string,
  ): Promise<void>;
  ensureAnchor(
    viewId: string,
    revision: number,
    anchor: Pick<import("./readingViews.js").ReadingAnchor, "turnId" | "itemId">,
    generation: string,
  ): Promise<"ready" | import("./conversationReading.js").ReadingBlock>;
  loadOlder(pageId?: string): Promise<void>;
  loadItem(itemId: string): Promise<void>;
}
export interface PlatformServices {
  capabilities?: {
    mutations: boolean;
    conversationSubmit?: boolean;
    conversationCreate?: boolean;
    native: boolean;
    library?: boolean;
    taskCatalog?: boolean;
    taskManage?: boolean;
    pages?: boolean;
    settings?: readonly string[];
  };
  reads?: PlatformReadServices;
  /** 写开关打开时由 Host 接管的命令；返回 undefined 表示仍走桌面原路径。 */
  writes?: {
    route(
      name: string,
      params: Record<string, unknown>,
    ): Promise<{ routed: true; value?: unknown } | undefined>;
  };
  /** 按领域切到 Host 工作台服务的命令；返回 undefined 表示仍走桌面原路径。 */
  workbench?: {
    call(name: string, params: Record<string, unknown>): Promise<{ value: unknown } | undefined>;
  };
  /** 默认桌面的受阻历史视图；null 关闭视图，不能恢复执行或重放原请求。 */
  recoverPersistedHistory?(target: { projectId: string; threadId: string } | null): Promise<void>;
  getHostTicket?(): Promise<unknown>;
  snapShots?: SnapShotServices;
  mcpApp?: McpAppCommand;
  onMcpAppEvent?(listener: (event: McpAppEvent) => void): () => void;
  onMcpAppDeepLink?(listener: (link: McpAppDeepLink) => Promise<void> | void): () => void;
  mcpFormResource?: McpFormResourceCommand;
  /** The themed initial window has painted; desktop may reveal before backend or history restoration. */
  presentReady?(): Promise<void>;
  installCommandLineTools?(): Promise<{ started: boolean; message?: string }>;
  onQuitRequested?(listener: () => Promise<boolean>): () => void;
  onQuitProgress?(listener: (progress: QuitProgress) => void): () => void;
  onNotificationOpen?(listener: (target: NotificationTarget) => void): () => void;
  updateState?(): Promise<UpdateState>;
  downloadUpdate?(): Promise<UpdateState>;
  recoverUpdateResources?(): Promise<UpdateState>;
  onUpdate?(listener: (state: UpdateState) => void): () => void;
  snapshot(): Promise<Snapshot>;
  onState(listener: (state: Snapshot) => void): () => void;
  chooseProject(): Promise<string | null>;
  chooseTaskDirectory?(): Promise<{ cwd: string } | null>;
  chooseProjectlessDirectory?(): Promise<{ directory: string } | null>;
  /** 用系统浏览器打开外部链接（登录授权页等）。 */
  openExternal?(url: string): Promise<void>;
  fileOpen?(
    request: FileOpenRequest,
  ): Promise<FileOpenTargets | { saved: boolean } | WorkspaceImage | Record<string, never>>;
  command<N extends CommandName>(
    name: N,
    params: CommandParams<N>,
  ): Promise<DesktopResult<unknown>>;
  theme(id?: string): Promise<{
    platform?: string;
    dark: boolean;
    id: string;
  }>;
  onTheme(listener: (theme: { platform?: string; dark: boolean; id: string }) => void): () => void;
  preview(params: Exclude<PreviewRequest, { operation: "show" }>): Promise<Data>;
  preview(params: PreviewRequest): Promise<Data | null>;
  onPreviewEvent?(listener: (event: Data) => void): () => void;
}
export type PreparedCreator = CommandResponse<"prepareCreator">;
export interface Action {
  <N extends CommandName, P extends CommandParams<N>>(
    name: N,
    params: P,
  ): Promise<CommandResponse<N, P>>;
}
const READ_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  tasks: new Set([
    "list",
    "preview",
    "observe",
    "inbox",
    "task",
    "taskDraftRead",
    "taskDraftHistory",
    "taskHistoryCapabilities",
  ]),
  providers: new Set(["list"]),
  manage: new Set(["inspect", "list"]),
  workspace: new Set(["list", "read", "status", "worktreeList", "worktreeStatus"]),
};
type ServiceReadGuard = {
  inFlightExact: Map<string, Promise<unknown>>;
  inFlightCatalog: Map<string, string>;
  turnTargets: Map<string, string>;
  turnScheduled: boolean;
};
const serviceReadGuards = new WeakMap<PlatformServices, ServiceReadGuard>();
function getReadGuard(services: PlatformServices): ServiceReadGuard {
  let guard = serviceReadGuards.get(services);
  if (!guard) {
    guard = {
      inFlightExact: new Map(),
      inFlightCatalog: new Map(),
      turnTargets: new Map(),
      turnScheduled: false,
    };
    serviceReadGuards.set(services, guard);
  }
  return guard;
}
function stableJson(value: unknown, omitKeys?: ReadonlySet<string>): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined && !omitKeys?.has(key))
    .sort()
    .map((key) => [key, record[key]]);
  return JSON.stringify(Object.fromEntries(entries));
}
const TRANSIENT_READ_KEYS = new Set(["requestId", "viewEpoch"]);
function classifyReadCall(name: string, params: unknown) {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const operation =
    typeof record.operation === "string" ? record.operation : name === "tasks" ? "list" : undefined;
  const isRead =
    name === "history" ||
    (operation !== undefined && READ_OPERATIONS[name]?.has(operation) === true);
  if (!isRead) return null;
  const exactKey = `${name}:${stableJson(record)}`;
  const logicalKey = `${name}:${operation ?? ""}:${stableJson(record, TRANSIENT_READ_KEYS)}`;
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  const catalogTarget =
    name === "tasks" && (operation === "preview" || operation === "observe" || operation === "list")
      ? `${typeof record.projectId === "string" ? record.projectId : "*"}:${typeof record.sourceThreadId === "string" ? record.sourceThreadId : "*"}`
      : null;
  return { operation: operation ?? "read", exactKey, logicalKey, requestId, catalogTarget };
}
async function executeCall<N extends CommandName, P extends CommandParams<N>>(
  services: PlatformServices,
  name: N,
  params: P,
): Promise<CommandResponse<N, P>> {
  const contract: typeof import("./desktop-services.js") = await import("./desktop-services.js");
  await contract.validateCommand(name, params);
  const routed = await services.workbench?.call(name, params as Record<string, unknown>);
  if (routed) {
    await contract.validateCommandResponse(name, params, routed.value);
    return routed.value as CommandResponse<N, P>;
  }
  const written = await services.writes?.route(name, params as Record<string, unknown>);
  if (written) {
    const value =
      "value" in written
        ? written.value
        : name === "respond" || name === "steer"
          ? await services.snapshot()
          : { stopped: true };
    if ("value" in written) await contract.validateCommandResponse(name, params, value);
    return value as CommandResponse<N, P>;
  }
  const result = await services.command(name, params);
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error); // raw-error-ok: 传输层解码，不上屏
  try {
    await contract.validateCommandResponse(name, params, result.value);
  } catch (error) {
    throw contract.commandResponseError(name, params, error);
  }
  return result.value as CommandResponse<N, P>;
}
export async function call<N extends CommandName, P extends CommandParams<N>>(
  services: PlatformServices,
  name: N,
  params: P,
): Promise<CommandResponse<N, P>> {
  const readMeta = classifyReadCall(name, params);
  if (!readMeta) return executeCall(services, name, params);
  const guard = getReadGuard(services);
  const existingExact = guard.inFlightExact.get(readMeta.exactKey);
  if (existingExact) return existingExact as Promise<CommandResponse<N, P>>;
  if (readMeta.catalogTarget) {
    const activeOp = guard.inFlightCatalog.get(readMeta.catalogTarget);
    if (
      activeOp &&
      activeOp !== readMeta.operation &&
      (activeOp === "preview" || readMeta.operation === "preview")
    ) {
      throw Object.assign(
        new Error(
          `禁止对同一目标 (${readMeta.catalogTarget}) 并发发起 ${activeOp} 与 ${readMeta.operation} 双重读取 (FANOUT_N_TIMES_2_FORBIDDEN)`,
        ),
        { code: "FANOUT_N_TIMES_2_FORBIDDEN" },
      );
    }
  }
  const existingTurnReq = guard.turnTargets.get(readMeta.logicalKey);
  if (existingTurnReq !== undefined && existingTurnReq !== readMeta.requestId) {
    throw Object.assign(
      new Error(
        `禁止在同一事件轮次对同一目标重复扇出读取请求 (${readMeta.logicalKey}) (FANOUT_DUPLICATE_TARGET_FORBIDDEN)`,
      ),
      { code: "FANOUT_DUPLICATE_TARGET_FORBIDDEN" },
    );
  }
  guard.turnTargets.set(readMeta.logicalKey, readMeta.requestId);
  if (!guard.turnScheduled) {
    guard.turnScheduled = true;
    queueMicrotask(() => {
      guard.turnTargets.clear();
      guard.turnScheduled = false;
    });
  }
  if (readMeta.catalogTarget) {
    guard.inFlightCatalog.set(readMeta.catalogTarget, readMeta.operation);
  }
  const promise = executeCall(services, name, params).finally(() => {
    guard.inFlightExact.delete(readMeta.exactKey);
    if (
      readMeta.catalogTarget &&
      guard.inFlightCatalog.get(readMeta.catalogTarget) === readMeta.operation
    ) {
      guard.inFlightCatalog.delete(readMeta.catalogTarget);
    }
  });
  guard.inFlightExact.set(readMeta.exactKey, promise);
  return promise;
}

export { isLibraryState } from "./desktop-response.js";
