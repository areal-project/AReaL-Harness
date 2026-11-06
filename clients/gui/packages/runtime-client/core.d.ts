export type OperationTarget =
  | { kind: "project" }
  | { kind: "thread"; threadId: string }
  | { kind: "task"; taskId: string };
export type OperationRef = { method: string; requestId?: string; target: OperationTarget };
export type FailureOutcome =
  | { kind: "noMutation" | "rejected" }
  | { kind: "admitted" | "unconfirmed"; operation: OperationRef };
export type Recovery = { kind: "retryRead" | "queryOriginal" | "needsUser" | "none" };
export type MethodSemantics = {
  effect: "read" | "subscription" | "mutation";
  receipt?: "thread" | "task" | "management";
};
export const MAX_RESPONSE_BYTES: number;
export class CoreRpcError extends Error {
  constructor(
    message: string,
    options?: {
      code?: string | number;
      method?: string;
      data?: CoreRpcError["data"];
      cause?: unknown;
      submissionUnknown?: boolean;
    },
  );
  code?: string | number;
  method?: string;
  outcome?: FailureOutcome;
  recovery?: Recovery;
  data?: {
    outcome?: FailureOutcome;
    recovery?: Recovery;
    reason?: string;
    requestId?: string;
    retryable?: boolean;
    delivery?: "resultUnavailable";
    [key: string]: unknown;
  };
  reason?: string;
  requestId?: string;
  delivery?: "resultUnavailable";
  submissionUnknown: boolean;
}
export interface CoreSocketEvents {
  open: unknown;
  message: { data: unknown };
  close: { code: number; reason: string };
  error: { error?: unknown; code?: string };
}
export interface CoreSocket {
  readonly readyState: number;
  addEventListener<Event extends keyof CoreSocketEvents>(
    type: Event,
    listener: (event: CoreSocketEvents[Event]) => void,
    options?: { once?: boolean },
  ): void;
  send(data: string): void;
  close(): void;
}
export class CoreClient {
  constructor(options: {
    createSocket: () => CoreSocket;
    timeoutMs?: number;
    onServerRequest?: (
      method: string,
      params: unknown,
      context: { requestId: string; signal: AbortSignal },
    ) => Promise<unknown>;
  });
  ready: boolean;
  closed: boolean;
  closeFailure: CoreRpcError | null;
  capabilities?: import("./capabilities.js").CoreCapabilities;
  connect(): Promise<NonNullable<CoreClient["capabilities"]>>;
  request<Result>(
    method: string,
    params: object | undefined,
    options: {
      decode: (value: unknown) => Result;
      onResult?: (result: Result) => void;
      timeoutMs?: number;
      maxResponseBytes?: number;
    },
  ): Promise<Result>;
  request(
    method: string,
    params?: object,
    options?: {
      onResult?: (result: unknown) => void;
      timeoutMs?: number;
      maxResponseBytes?: number;
    },
  ): Promise<unknown>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onClose(listener: (failure: CoreRpcError) => void): () => void;
  close(): void;
}

export type ModelUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export type GenerationStats = {
  outputTokens: number;
  durationMs: number;
  measuredRequests: number;
  unmeasuredRequests: number;
  usageRequests: number;
  missingUsageRequests: number;
};
export type ContextPartKind =
  | "systemPrompt"
  | "rules"
  | "skills"
  | "toolDefinitions"
  | "conversation"
  | "summary"
  | "attachments"
  | "toolResults"
  | "other";
export type ContextPart = {
  kind: ContextPartKind;
  name: string;
  estimatedTokens: number;
  children?: ContextPart[];
};
export type InstructionAttribution = { sha256: string; parts: ContextPart[] };
export type TurnUsage = {
  usage?: ModelUsage | null;
  generation?: GenerationStats | null;
  instructionAttribution?: InstructionAttribution | null;
};
export type ContextBasis = {
  provider: string;
  model: string;
  configurationRevision: number;
  defaultModelRevision: string | null;
  turnId: string | null;
};
export type ContextBudget = {
  windowTokens: number;
  outputReserveTokens: number;
  inputLimitTokens: number;
  windowSource: "account" | "provider" | "user" | "modelDefault" | "fallback" | "model";
  reportedWindowTokens?: number;
  reportedWindowSource?: "account" | "provider";
  userBudgetTokens?: number;
};
export type ContextUsage =
  | {
      kind: "ready";
      basis: ContextBasis;
      budget: ContextBudget;
      scope: { kind: "assembledRequest"; sequence: number } | { kind: "recordedHistory" };
      estimate: { tokens: number; parts: ContextPart[] };
    }
  | {
      kind: "unavailable";
      basis: ContextBasis;
      budget: ContextBudget | null;
      reason: "awaitingRequest" | "modelUnavailable" | "instructionBasisChanged";
    };
export type SessionUsage = {
  usage: ModelUsage | null;
  generation: GenerationStats;
  knownTurns: number;
  unknownTurns: number;
  partialTurns: number;
  scope: "ownTurns";
};
export type ContextUsageResponse = {
  threadId: string;
  contextUsage: ContextUsage;
  sessionUsage: SessionUsage;
};
