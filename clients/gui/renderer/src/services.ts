// The renderer consumes only the narrow preload contract. Execution facts remain in Core.
import type {
  CommandName,
  CommandParams,
  CommandResponse,
  DesktopResult,
  PreviewRequest,
  NotificationTarget,
  QuitProgress,
} from "@areal/workbench/desktop-contract";
import type {
  McpAppCommand,
  McpAppDeepLink,
  McpAppEvent,
  McpFormResourceCommand,
} from "./mcp-app-services.js";
export type { CommandName, CommandParams, CommandResponse };
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
      operation: "open" | "reveal" | "saveAs" | "readImage";
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
  subscription?: import("@areal/workbench/desktop-contract/provider").ChatGPTStatus;
  desktopCapabilities?: { currentCommands: boolean };
  power?: { enabled: boolean; active: boolean; error: string | null } | null;
  menuBar?: { supported: boolean; active: boolean; error: string | null } | null;
  projectless?: { directory: string };
  revision?: number;
  connection?: {
    state: "connecting" | "ready" | "unavailable";
    message?: string;
    recovery?: "check";
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
export type { NotificationTarget, QuitProgress } from "@areal/workbench/desktop-contract";
export interface PlatformServices {
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
  const contract: typeof import("@areal/workbench/desktop-contract") =
    await import("@areal/workbench/desktop-contract");
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
