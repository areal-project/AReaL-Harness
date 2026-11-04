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
  status: "idle" | "available" | "downloading" | "validating" | "deferred" | "installing" | "error";
  version?: string;
  downloaded?: string;
  installing?: boolean;
  percent?: number | null;
  detail?: string;
}
export type { NotificationTarget, QuitProgress } from "./desktop-services.js";
export interface PlatformServices {
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
export async function call<N extends CommandName, P extends CommandParams<N>>(
  services: PlatformServices,
  name: N,
  params: P,
): Promise<CommandResponse<N, P>> {
  const contract: typeof import("./desktop-services.js") = await import("./desktop-services.js");
  contract.validateCommand(name, params);
  const result = await services.command(name, params);
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
  try {
    contract.validateCommandResponse(name, params, result.value);
  } catch (error) {
    throw contract.commandResponseError(name, params, error);
  }
  return result.value;
}
