import type { BotModelOption, BotProviderHealth, BotProviderOption } from "../host-bots.js";

export interface BotToolActivity {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
}

export interface BotChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  turnId?: string;
  streaming?: boolean;
  error?: string;
  activities?: BotToolActivity[];
}

export interface BotPendingInteraction {
  requestId: string;
  turnId: string;
  title: string;
  detail?: string;
  argumentsDigest?: string;
}

export interface BotConversationState {
  messages: BotChatMessage[];
  pendingInteractions: BotPendingInteraction[];
  models: BotModelOption[];
  providers: BotProviderOption[];
  providerHealth?: BotProviderHealth | null;
  observed: boolean;
  observing: boolean;
}

export const emptyConversation = (): BotConversationState => ({
  messages: [],
  pendingInteractions: [],
  models: [],
  providers: [],
  providerHealth: null,
  observed: false,
  observing: false,
});

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function extractTurnError(rawTurn: unknown): string | undefined {
  if (!isRecord(rawTurn)) return undefined;
  const info = rawTurn.error;
  if (typeof info === "string" && info.trim()) return info.trim();
  if (isRecord(info)) {
    const text = info["message"];
    if (typeof text === "string" && text.trim()) return text.trim();
    const outcome = isRecord(info.outcome) ? info.outcome : undefined;
    if (outcome && typeof outcome.code === "string" && outcome.code.trim()) {
      return outcome.code.trim();
    }
  }
  if (rawTurn.status === "failed") return "Turn failed";
  return undefined;
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function summarizeToolItem(item: Record<string, unknown>): BotToolActivity {
  const id = typeof item.id === "string" ? item.id : crypto.randomUUID();
  const type = typeof item.type === "string" ? item.type : "tool";
  const toolName =
    (typeof item.toolName === "string" && item.toolName) ||
    (typeof item.name === "string" && item.name) ||
    (typeof item.command === "string" && item.command.slice(0, 60)) ||
    type;
  const rawStatus = typeof item.status === "string" ? item.status : "completed";
  const status: BotToolActivity["status"] =
    rawStatus === "failed" || rawStatus === "error"
      ? "failed"
      : rawStatus === "running" || rawStatus === "inProgress"
        ? "running"
        : "completed";
  return { id, label: toolName, status };
}

export function extractTimelineFromThread(thread: Record<string, unknown>): {
  messages: BotChatMessage[];
  pendingInteractions: BotPendingInteraction[];
} {
  const messages: BotChatMessage[] = [];
  const pendingInteractions: BotPendingInteraction[] = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];

  for (const rawTurn of turns) {
    if (!isRecord(rawTurn)) continue;
    const turnId = typeof rawTurn.id === "string" ? rawTurn.id : undefined;
    const turnError = extractTurnError(rawTurn);
    const turnRunning = rawTurn.status === "inProgress" || rawTurn.status === "running";
    const items = Array.isArray(rawTurn.items) ? rawTurn.items : [];
    const turnActivities: BotToolActivity[] = [];
    let lastAssistantIndex = -1;

    for (const rawItem of items) {
      if (!isRecord(rawItem)) continue;
      const type = typeof rawItem.type === "string" ? rawItem.type : "";
      const id =
        typeof rawItem.id === "string" ? rawItem.id : `${turnId ?? "t"}-${messages.length}`;

      if (type === "userMessage") {
        const text =
          (typeof rawItem.text === "string" && rawItem.text) ||
          extractTextFromContent(rawItem.content) ||
          extractTextFromContent(rawItem.input);
        if (text.trim()) {
          messages.push({ id, role: "user", text, turnId });
        }
      } else if (type === "agentMessage") {
        const text =
          (typeof rawItem.text === "string" && rawItem.text) ||
          extractTextFromContent(rawItem.content);
        const streaming =
          turnRunning && (rawItem.status === "inProgress" || rawItem.status === "streaming");
        if (!text.trim() && !streaming && turnActivities.length === 0 && !turnError) {
          continue;
        }
        const msg: BotChatMessage = {
          id,
          role: "assistant",
          text,
          turnId,
          streaming,
          ...(turnActivities.length > 0 ? { activities: [...turnActivities] } : {}),
        };
        turnActivities.length = 0;
        lastAssistantIndex = messages.length;
        messages.push(msg);
      } else if (type && type !== "reasoning") {
        turnActivities.push(summarizeToolItem(rawItem));
      }
    }

    if (turnActivities.length > 0) {
      if (lastAssistantIndex >= 0) {
        const existing = messages[lastAssistantIndex];
        existing.activities = [...(existing.activities ?? []), ...turnActivities];
      } else {
        lastAssistantIndex = messages.length;
        messages.push({
          id: `${turnId ?? "turn"}-activity`,
          role: "assistant",
          text: "",
          turnId,
          streaming: turnRunning,
          activities: turnActivities,
        });
      }
    }

    if (turnError) {
      if (lastAssistantIndex >= 0) {
        messages[lastAssistantIndex].error = turnError;
        messages[lastAssistantIndex].streaming = false;
      } else {
        messages.push({
          id: `${turnId ?? "turn"}-error-${messages.length}`,
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          error: turnError,
        });
      }
    }
  }

  const desktop = isRecord(thread.desktop) ? thread.desktop : undefined;
  const interactions = Array.isArray(desktop?.pendingInteractions)
    ? desktop.pendingInteractions
    : Array.isArray(thread.pendingInteractions)
      ? thread.pendingInteractions
      : [];
  for (const raw of interactions) {
    if (!isRecord(raw) || typeof raw.requestId !== "string") continue;
    pendingInteractions.push({
      requestId: raw.requestId,
      turnId: typeof raw.turnId === "string" ? raw.turnId : "",
      title:
        (typeof raw.title === "string" && raw.title) ||
        (typeof raw.toolName === "string" && raw.toolName) ||
        "",
      detail:
        (typeof raw.summary === "string" && raw.summary) ||
        (typeof raw.prompt === "string" && raw.prompt) ||
        undefined,
      argumentsDigest: typeof raw.argumentsDigest === "string" ? raw.argumentsDigest : undefined,
    });
  }

  return { messages, pendingInteractions };
}
