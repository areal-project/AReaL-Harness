// The renderer consumes only the narrow preload contract. Execution facts remain in Core.
import { validateCommand, validateCommandResponse } from '@areal/workbench/desktop-contract';
import type { CommandName, CommandParams, DesktopResult, PreviewRequest } from '@areal/workbench/desktop-contract';
import type { McpAppCommand, McpAppDeepLink, McpAppEvent, McpFormResourceCommand } from "./mcp-app-services.js";
export type { CommandName };
export type Data = Record<string, any>;
export type FileOpenTargets = { targets: { id: string; label: string }[]; preferred: string; preferredLabel: string };
export type FileOpenRequest = { operation: 'targets' } | { operation: 'setDefault'; target: string }
    | { operation: 'open' | 'reveal' | 'saveAs'; projectId: string; threadId?: string; path: string };
export interface Snapshot {
    projects: Data[];
    desktopCapabilities?: { currentCommands: boolean };
    power?: { enabled: boolean; active: boolean; error: string | null } | null;
    menuBar?: { supported: boolean; active: boolean; error: string | null } | null;
    projectless?: { directory: string };
    revision?: number;
    connection?: { state: 'connecting' | 'ready' | 'unavailable'; message?: string; recovery?: 'check' };
    serviceSummary?: { state: 'running' | 'stopped' | 'unknown'; busy: boolean };
    backendUpdate?: { state: 'applying' | 'pending' | 'failed'; message?: string };
    lifecycle?: { recovery?: { canRecover: boolean; message: string; projects: { projectId: string; root: string; state: string; message: string }[] }; supported: boolean; phase?: string; message?: string; error?: string; requestId?: string; kind?: string; desktopExit?: string;
      targets?: { projectId: string; phase: string; message?: string }[];
      operations: { requestId: string; kind: string; phase: string; message?: string; threadId?: string; turnId?: string;
        desktopExit?: string; targets: { projectId: string; phase: string; message?: string }[] }[] };
    library?: Data;
    computerControl?: Data | null;
}
export interface UpdateState {
    enabled: boolean;
    status: 'idle' | 'available' | 'downloading' | 'validating' | 'deferred' | 'installing' | 'error';
    version?: string;
    downloaded?: string;
    installing?: boolean;
    percent?: number | null;
    detail?: string;
}
export type NotificationTarget = { projectId: string } & ({ threadId: string; taskId?: never } | { taskId: string; runId?: string; questionId?: string });
export type QuitProgress = { state: 'idle' } | { state: 'quitting'; phase: 'checking' | 'stopping' | 'finishing' };
export interface PlatformServices {
    mcpApp?: McpAppCommand;
    onMcpAppEvent?(listener: (event: McpAppEvent) => void): () => void;
    onMcpAppDeepLink?(listener: (link: McpAppDeepLink) => Promise<void> | void): () => void;
    mcpFormResource?: McpFormResourceCommand;
    /** The themed initial window has painted; desktop may reveal before backend or history restoration. */
    presentReady?(): Promise<void>;
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
    fileOpen?(request: FileOpenRequest): Promise<FileOpenTargets | { saved: boolean } | Record<string, never>>;
    command<N extends CommandName>(name: N, params: CommandParams<N>): Promise<DesktopResult<unknown>>;
    theme(id?: string): Promise<{
        platform?: string;
        dark: boolean;
        id: string;
    }>;
    onTheme(listener: (theme: {
        platform?: string;
        dark: boolean;
        id: string;
    }) => void): () => void;
    preview(params: PreviewRequest): Promise<Data>;
    onPreviewEvent?(listener: (event: Data) => void): () => void;
}
type SideRequest = CommandParams<"side">;
export type PreparedCreator = {
  projectId: string;
  profile: { id: string; revision: string };
  skill: { id: string; revision: string; name: string; description: string };
  provenance: { upstream: string; revision: string; contentDigest: string };
};
type SideResult<Operation extends SideRequest["operation"]> =
  Operation extends "start" | "create" ? { threadId: string; requestId: string; turnId?: string } :
  Operation extends "close" ? { requestId: string; threadId: string; accepted: boolean; cleanupConfirmed: boolean } :
  Operation extends "recover" ? { confirmed: false } | { confirmed: true; requestId: string; threadId: string; turnId?: string; accepted?: boolean; cleanupConfirmed?: boolean } :
  Operation extends "list" ? { data: Record<string, unknown>[]; nextCursor?: string | null } :
  Operation extends "context" ? { snapshotId: string; evidence: Record<string, unknown>[]; nextCursor?: string | null } :
  { turn: { id: string } };
export interface Action {
  (name: "prepareCreator", params: CommandParams<"prepareCreator">): Promise<PreparedCreator>;
  <Request extends SideRequest>(name: "side", params: Request): Promise<SideResult<Request["operation"]>>;
  (name: "fork", params: CommandParams<"fork">): Promise<{ threadId: string; requestId: string }>;
  (name: "configure", params: CommandParams<"configure">): Promise<Snapshot>;
  <Name extends Exclude<CommandName, "prepareCreator" | "side" | "fork" | "configure">>(name: Name, params?: Data): Promise<any>;
}
// 业务投影仍由各能力所有者建模；此适配保留现有 Action 调用方的返回类型。
export async function call<N extends CommandName>(services: PlatformServices, name: N, params: CommandParams<N>): Promise<any> { validateCommand(name, params); const result = await services.command(name, params); if (!result.ok)
    throw Object.assign(new Error(result.error.message), result.error); validateCommandResponse(name, params, result.value); return result.value; }
