import type { HostClient, JsonObject } from "@areal/client";

export type BotSystemPromptMode = "personalAgent" | "default";
export type BotProviderSyncMode = "auto" | "arenaOnly" | "hostSync";

export interface BotModelRef {
  providerId?: string;
  modelId: string;
}

export type BotConnectionState =
  | { kind: "sleeping" }
  | { kind: "waking"; startedAt?: number; message?: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface BotProviderHealth {
  status: "ready" | "authFailed" | "unchecked" | "unavailable";
  providerId?: string | null;
  modelId?: string | null;
  message?: string | null;
  supportsCredentialRegistration?: boolean;
}

export interface BotPendingSubmission {
  requestId: string;
  threadId: string;
  digest: string;
  preview: string;
  createdAt: number;
}

export interface BotCustomProvider {
  id: string;
  endpoint: string;
  protocol: string;
  models: string[];
  credentialRef?: string | null;
}

export interface BotRecord {
  id: string;
  name: string;
  avatar: string;
  description: string;
  workspace: string;
  starterPrompts: string[];
  systemPromptMode: BotSystemPromptMode;
  preferences: string;
  preferencesRevision: number;
  syncedPreferencesRevision: number;
  preferencesDirty: boolean;
  modelOverride?: BotModelRef | null;
  providerSyncMode: BotProviderSyncMode;
  customProviders?: BotCustomProvider[];
  threadRequestId: string;
  activeThreadId?: string | null;
  activeTurnId?: string | null;
  lastMessagePreview: string;
  lastActiveAt: number;
  createdAt: number;
  updatedAt: number;
  pendingSubmission?: BotPendingSubmission | null;
  connectionState: BotConnectionState;
  providerHealth?: BotProviderHealth | null;
  modelsCount?: number;
}

export interface ArenaSettingsView {
  baseUrl?: string | null;
  profile: string;
  hasToken: boolean;
  tokenSource: "host" | "toml" | "none";
  ready: boolean;
}

export interface BotModelOption {
  id?: string;
  providerId?: string;
  modelId?: string;
  displayName?: string;
  [key: string]: unknown;
}

export interface BotProviderOption {
  id?: string;
  revision?: number;
  displayName?: string;
  endpoint?: string;
  baseUrl?: string;
  protocol?: string;
  apiStyle?: string;
  models?: string[];
  credentialRef?: string | null;
  credentialState?: string;
  [key: string]: unknown;
}

export interface BotListResponse {
  revision: number;
  arena: ArenaSettingsView;
  bots: BotRecord[];
}

export interface BotConnectResponse {
  bot: BotRecord;
  models: BotModelOption[];
  providers: BotProviderOption[];
  providerHealth?: BotProviderHealth | null;
}

export interface BotObserveResponse {
  bot: BotRecord;
  thread: Record<string, unknown>;
  models?: BotModelOption[];
  providers?: BotProviderOption[];
  providerHealth?: BotProviderHealth | null;
}

export interface BotModelsResponse {
  bot?: BotRecord;
  botId?: string;
  models: BotModelOption[];
  providers: BotProviderOption[];
  providerHealth?: BotProviderHealth | null;
}

export interface BotSendResponse {
  bot?: BotRecord;
  admissionState: "accepted" | "unknown";
  submissionUnknown: boolean;
  receipt?: Record<string, unknown>;
  pendingSubmission?: BotPendingSubmission;
  commandId: string;
}

export interface BotReconcileResponse {
  bot: BotRecord;
  pending: boolean;
  status: "idle" | "admitted" | "notAdmitted" | "unknown";
  receipt?: Record<string, unknown>;
  pendingSubmission?: BotPendingSubmission;
  thread?: Record<string, unknown>;
}

export interface BotEventNotification {
  kind: string;
  botId?: string;
  workspace?: string;
  connectionId?: string;
  revision?: number;
  state?: BotConnectionState;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CreateBotParams {
  name: string;
  avatar?: string;
  description?: string;
  workspace?: string;
  starterPrompts?: string[];
  systemPromptMode?: BotSystemPromptMode;
  preferences?: string;
  modelOverride?: BotModelRef | null;
  providerSyncMode?: BotProviderSyncMode;
}

export interface UpdateBotParams {
  id: string;
  expectedRevision?: number;
  name?: string;
  avatar?: string;
  description?: string;
  starterPrompts?: string[];
  systemPromptMode?: BotSystemPromptMode;
  preferences?: string;
  modelOverride?: BotModelRef | null;
  providerSyncMode?: BotProviderSyncMode;
}

export interface ConfigureArenaParams {
  baseUrl?: string | null;
  profile?: string | null;
  token?: string;
  clearToken?: boolean;
}

export interface UpsertBotProviderParams {
  id: string;
  provider: Record<string, unknown>;
  expectedRevision?: number;
  modelOverride?: BotModelRef | null;
}

export interface BotServices {
  available(): boolean;
  settings(): Promise<ArenaSettingsView>;
  list(): Promise<BotListResponse>;
  get(id: string): Promise<{ revision: number; bot: BotRecord }>;
  observe(id: string): Promise<BotObserveResponse>;
  models(id: string): Promise<BotModelsResponse>;
  harnessModels?(): Promise<BotModelOption[]>;
  reconcile(id: string): Promise<BotReconcileResponse>;
  configureArena(params: ConfigureArenaParams): Promise<{ arena: ArenaSettingsView }>;
  create(params: CreateBotParams): Promise<{ revision: number; bot: BotRecord }>;
  update(params: UpdateBotParams): Promise<{ revision: number; bot: BotRecord }>;
  remove(id: string, expectedRevision?: number): Promise<{ revision: number; removed: string }>;
  connect(id: string): Promise<BotConnectResponse>;
  disconnect(id: string): Promise<{ bot: BotRecord }>;
  send(id: string, text: string, commandId?: string): Promise<BotSendResponse>;
  interrupt(id: string): Promise<{ interrupted: boolean; bot: BotRecord }>;
  respondInteraction(
    id: string,
    interactionId: string,
    response: Record<string, unknown>,
  ): Promise<{ bot: BotRecord; result: unknown }>;
  compact(id: string): Promise<{ bot: BotRecord; result: unknown }>;
  resetConversation(id: string): Promise<{ revision: number; bot: BotRecord }>;
  upsertProvider(params: UpsertBotProviderParams): Promise<BotConnectResponse>;
  onEvent(listener: (event: BotEventNotification) => void): () => void;
}

type BotsHostClient = Pick<HostClient, "workbench" | "writable"> & {
  subscribeBotEvents(listener: (event: unknown) => void): () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function cleanParams(value: Record<string, unknown>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as JsonObject;
}

function unwrapCommandReceipt<T>(result: unknown): T {
  if (!isRecord(result)) throw new Error("Invalid bots.command response");
  if ("receipt" in result && result.receipt !== undefined) return result.receipt as T;
  return result as T;
}

export function createHostBots(client: BotsHostClient): {
  bots: BotServices;
  dispose: () => void;
} {
  const listeners = new Set<(event: BotEventNotification) => void>();
  let disposed = false;

  const offEvents = client.subscribeBotEvents((raw) => {
    if (disposed || !isRecord(raw) || raw.event !== "bots.event") return;
    if (!isRecord(raw.notification) || typeof raw.notification.kind !== "string") return;
    const notification = raw.notification as BotEventNotification;
    for (const listener of listeners) listener(notification);
  });

  const read = async <T>(params: Record<string, unknown>): Promise<T> =>
    (await client.workbench("bots.read", cleanParams(params))) as T;

  const command = async <T>(
    params: Record<string, unknown>,
    commandId: string = crypto.randomUUID(),
  ): Promise<T> => {
    const result = await client.workbench("bots.command", cleanParams(params), commandId);
    return unwrapCommandReceipt<T>(result);
  };

  const bots: BotServices = {
    available: () => client.writable("bots.read") && client.writable("bots.command"),
    async harnessModels() {
      const catalog = (await client.workbench("providers.read", { operation: "list" })) as {
        data: Array<{
          id: string;
          name: string;
          enabled: boolean;
          models: Array<{ id: string; enabled: boolean; displayName?: string }>;
        }>;
      };
      return catalog.data
        .filter((provider) => provider.enabled)
        .flatMap((provider) =>
          provider.models
            .filter((model) => model.enabled)
            .map((model) => ({
              providerId: provider.id,
              modelId: model.id,
              displayName: model.displayName ?? model.id,
            })),
        );
    },
    settings: () => read<ArenaSettingsView>({ operation: "settings" }),
    list: () => read<BotListResponse>({ operation: "list" }),
    get: (id) => read<{ revision: number; bot: BotRecord }>({ operation: "get", id }),
    observe: (id) => read<BotObserveResponse>({ operation: "observe", id }),
    models: (id) => read<BotModelsResponse>({ operation: "models", id }),
    reconcile: (id) => read<BotReconcileResponse>({ operation: "reconcile", id }),
    configureArena: (params) =>
      command<{ arena: ArenaSettingsView }>({ operation: "configureArena", ...params }),
    create: (params) =>
      command<{ revision: number; bot: BotRecord }>({ operation: "create", ...params }),
    update: (params) =>
      command<{ revision: number; bot: BotRecord }>({ operation: "update", ...params }),
    remove: (id, expectedRevision) =>
      command<{ revision: number; removed: string }>({
        operation: "remove",
        id,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    connect: (id) => command<BotConnectResponse>({ operation: "connect", id }),
    disconnect: (id) => command<{ bot: BotRecord }>({ operation: "disconnect", id }),
    async send(id, text, commandId = crypto.randomUUID()) {
      const raw = await client.workbench(
        "bots.command",
        cleanParams({ operation: "send", id, text }),
        commandId,
      );
      if (!isRecord(raw)) throw new Error("Invalid bots.command send response");
      const receipt = isRecord(raw.receipt) ? raw.receipt : undefined;
      const admissionState =
        raw.admissionState === "unknown" ||
        raw.submissionUnknown === true ||
        receipt?.admissionState === "unknown" ||
        receipt?.submissionUnknown === true
          ? "unknown"
          : "accepted";
      return {
        commandId: typeof raw.commandId === "string" ? raw.commandId : commandId,
        admissionState,
        submissionUnknown: admissionState === "unknown",
        bot: (receipt?.bot ?? raw.bot) as BotRecord | undefined,
        receipt: (receipt?.receipt ?? receipt) as Record<string, unknown> | undefined,
        pendingSubmission: (receipt?.pendingSubmission ?? raw.pendingSubmission) as
          | BotPendingSubmission
          | undefined,
      };
    },
    interrupt: (id) =>
      command<{ interrupted: boolean; bot: BotRecord }>({ operation: "interrupt", id }),
    respondInteraction: (id, interactionId, response) =>
      command<{ bot: BotRecord; result: unknown }>({
        operation: "respondInteraction",
        id,
        interactionId,
        response,
      }),
    compact: (id) => command<{ bot: BotRecord; result: unknown }>({ operation: "compact", id }),
    resetConversation: (id) =>
      command<{ revision: number; bot: BotRecord }>({ operation: "resetConversation", id }),
    upsertProvider: (params) =>
      command<BotConnectResponse>({ operation: "upsertProvider", ...params }),
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    bots,
    dispose() {
      disposed = true;
      offEvents();
      listeners.clear();
    },
  };
}
