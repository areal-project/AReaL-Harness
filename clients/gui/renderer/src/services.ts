// The renderer consumes only the narrow preload contract. Execution facts remain in Core.
import { validateCommand } from '@areal/workbench/desktop-contract';
import type { CommandName, CommandParams, DesktopResult, PreviewRequest } from '@areal/workbench/desktop-contract';
export type Data = Record<string, any>;
export type FileOpenTargets = { targets: { id: string; label: string }[]; preferred: string; preferredLabel: string };
export type FileOpenRequest = { operation: 'targets' } | { operation: 'setDefault'; target: string }
    | { operation: 'open' | 'reveal' | 'saveAs'; projectId: string; path: string };
export interface Snapshot {
    projects: Data[];
    power?: { enabled: boolean; active: boolean; error: string | null } | null;
    menuBar?: { supported: boolean; active: boolean; error: string | null } | null;
    projectless?: { directory: string };
    revision?: number;
    connection?: { state: 'connecting' | 'ready' | 'unavailable'; message?: string };
    library?: Data;
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
export interface PlatformServices {
    /** The initial selected view has committed; desktop may reveal its window. */
    presentReady?(): Promise<void>;
    onNotificationOpen?(listener: (target: NotificationTarget) => void): () => void;
    updateState?(): Promise<UpdateState>;
    downloadUpdate?(): Promise<UpdateState>;
    recoverUpdateResources?(): Promise<UpdateState>;
    onUpdate?(listener: (state: UpdateState) => void): () => void;
    snapshot(): Promise<Snapshot>;
    onState(listener: (state: Snapshot) => void): () => void;
    chooseProject(): Promise<string | null>;
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
}
export type Action = (name: CommandName, params?: Data) => Promise<any>;
// 业务投影仍由各能力所有者建模；此适配保留现有 Action 调用方的返回类型。
export async function call<N extends CommandName>(services: PlatformServices, name: N, params: CommandParams<N>): Promise<any> { validateCommand(name, params); const result = await services.command(name, params); if (!result.ok)
    throw Object.assign(new Error(result.error.message), result.error); return result.value; }
