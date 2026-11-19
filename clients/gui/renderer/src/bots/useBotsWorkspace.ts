import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArenaSettingsView,
  BotEventNotification,
  BotModelsResponse,
  BotRecord,
  BotServices,
  ConfigureArenaParams,
  CreateBotParams,
  UpdateBotParams,
  UpsertBotProviderParams,
} from "../host-bots.js";
import { errorCode, presentError } from "../errors/errorCopy.js";
import { useI18n } from "../i18n/IntlProvider.js";
import {
  emptyConversation,
  extractTimelineFromThread,
  extractTextFromContent,
  extractTurnError,
  isRecord,
  summarizeToolItem,
  type BotChatMessage,
  type BotConversationState,
  type BotPendingInteraction,
  type BotToolActivity,
} from "./botTimeline.js";

export {
  extractTimelineFromThread,
  type BotChatMessage,
  type BotConversationState,
  type BotPendingInteraction,
  type BotToolActivity,
};

export function useBotsWorkspace(service: BotServices | undefined, active: boolean) {
  const { t } = useI18n();
  const [bots, setBots] = useState<BotRecord[]>([]);
  const [revision, setRevision] = useState(0);
  const [arena, setArena] = useState<ArenaSettingsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, BotConversationState>>({});
  const [sendingBotId, setSendingBotId] = useState<string | null>(null);
  const [reconcilingBotId, setReconcilingBotId] = useState<string | null>(null);

  const selectedBotIdRef = useRef<string | null>(null);
  selectedBotIdRef.current = selectedBotId;
  const completedTurnIdsRef = useRef<Set<string>>(new Set());

  const upsertBotRecord = useCallback((record: BotRecord | undefined) => {
    if (!record) return;
    const normalized =
      record.activeTurnId && completedTurnIdsRef.current.has(record.activeTurnId)
        ? { ...record, activeTurnId: null }
        : record;
    setBots((prev) => {
      const idx = prev.findIndex((b) => b.id === normalized.id);
      const next =
        idx >= 0
          ? [...prev.slice(0, idx), normalized, ...prev.slice(idx + 1)]
          : [normalized, ...prev];
      return [...next].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
    });
  }, []);

  const updateConversation = useCallback(
    (botId: string, updater: (prev: BotConversationState) => BotConversationState) => {
      setConversations((prev) => ({
        ...prev,
        [botId]: updater(prev[botId] ?? emptyConversation()),
      }));
    },
    [],
  );

  const [modelAuthorizationError, setModelAuthorizationError] = useState(false);
  const reportError = useCallback(
    (cause: unknown) => {
      setModelAuthorizationError(errorCode(cause) === "BOT_MODEL_AUTH_REQUIRED");
      setError(presentError(t, cause).message);
    },
    [t],
  );

  const refreshList = useCallback(async () => {
    if (!service || !service.available()) return;
    setLoading(true);
    try {
      const res = await service.list();
      setRevision(res.revision);
      setArena(res.arena);
      setBots(res.bots);
      setSelectedBotId((current) => {
        if (current && res.bots.some((b) => b.id === current)) return current;
        return res.bots[0]?.id ?? null;
      });
      setError(null);
    } catch (cause) {
      reportError(cause);
    } finally {
      setLoading(false);
    }
  }, [reportError, service]);

  useEffect(() => {
    if (!active || !service || !service.available()) return;
    void refreshList();
  }, [active, refreshList, service]);

  const observeBot = useCallback(
    async (botId: string, refreshCatalog = false) => {
      if (!service || !service.available()) return;
      updateConversation(botId, (prev) => ({ ...prev, observing: true }));
      try {
        const res = await service.observe(botId);
        upsertBotRecord(res.bot);
        const timeline = extractTimelineFromThread(res.thread);
        let catalog: BotModelsResponse | undefined;
        if (refreshCatalog) {
          try {
            catalog = await service.models(botId);
            upsertBotRecord(catalog.bot);
          } catch {
            // Catalog refresh is best-effort; observe already succeeded.
          }
        }
        updateConversation(botId, (prev) => ({
          ...prev,
          messages: timeline.messages,
          pendingInteractions: timeline.pendingInteractions,
          models: catalog?.models ?? res.models ?? prev.models,
          providers: catalog?.providers ?? res.providers ?? prev.providers,
          providerHealth:
            catalog?.providerHealth ??
            res.providerHealth ??
            res.bot.providerHealth ??
            prev.providerHealth,
          observed: true,
          observing: false,
        }));
      } catch (cause) {
        updateConversation(botId, (prev) => ({ ...prev, observing: false }));
        reportError(cause);
      }
    },
    [reportError, service, updateConversation, upsertBotRecord],
  );

  // Subscribe to real-time bots.event stream from Host
  useEffect(() => {
    if (!service) return;
    return service.onEvent((event: BotEventNotification) => {
      if (event.kind === "registryChanged") {
        void refreshList();
        return;
      }
      const botId = event.botId;
      if (!botId) return;

      if (event.kind === "stateChanged" && event.state) {
        const nextState = event.state;
        setBots((prev) =>
          prev.map((b) =>
            b.id === botId
              ? {
                  ...b,
                  connectionState: nextState,
                  ...(nextState.kind === "sleeping" ? { activeTurnId: null } : {}),
                }
              : b,
          ),
        );
        return;
      }

      const payload = isRecord(event.payload) ? event.payload : {};

      if (event.kind === "turnStarted") {
        const turnId =
          (isRecord(payload.turn) && typeof payload.turn.id === "string" && payload.turn.id) ||
          (typeof payload.turnId === "string" && payload.turnId) ||
          undefined;
        setBots((prev) =>
          prev.map((b) => (b.id === botId ? { ...b, activeTurnId: turnId ?? b.activeTurnId } : b)),
        );
        return;
      }

      if (event.kind === "itemStarted") {
        const item = isRecord(payload.item) ? payload.item : undefined;
        const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
        if (!item) return;
        const itemId = typeof item.id === "string" ? item.id : crypto.randomUUID();
        const type = typeof item.type === "string" ? item.type : "";
        if (type === "agentMessage") {
          updateConversation(botId, (prev) => {
            if (prev.messages.some((m) => m.id === itemId)) return prev;
            return {
              ...prev,
              messages: [
                ...prev.messages,
                { id: itemId, role: "assistant", text: "", turnId, streaming: true },
              ],
            };
          });
        } else if (type && type !== "userMessage" && type !== "reasoning") {
          const activity = summarizeToolItem({ ...item, status: "running" });
          updateConversation(botId, (prev) => {
            const next = [...prev.messages];
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && last.turnId === turnId) {
              const existing = last.activities ?? [];
              next[next.length - 1] = {
                ...last,
                activities: [...existing.filter((a) => a.id !== activity.id), activity],
              };
            } else {
              next.push({
                id: `activity-${turnId ?? itemId}`,
                role: "assistant",
                text: "",
                turnId,
                streaming: true,
                activities: [activity],
              });
            }
            return { ...prev, messages: next };
          });
        }
        return;
      }

      if (event.kind === "messageDelta") {
        const itemId = typeof payload.itemId === "string" ? payload.itemId : "streaming";
        const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (!delta) return;
        updateConversation(botId, (prev) => {
          const next = [...prev.messages];
          const idx = next.findIndex((m) => m.id === itemId);
          if (idx >= 0) {
            next[idx] = { ...next[idx], text: next[idx].text + delta, streaming: true };
          } else {
            next.push({ id: itemId, role: "assistant", text: delta, turnId, streaming: true });
          }
          return { ...prev, messages: next };
        });
        return;
      }

      if (event.kind === "itemCompleted") {
        const item = isRecord(payload.item) ? payload.item : undefined;
        const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
        if (!item) return;
        const itemId = typeof item.id === "string" ? item.id : crypto.randomUUID();
        const type = typeof item.type === "string" ? item.type : "";
        if (type === "agentMessage") {
          const text =
            (typeof item.text === "string" && item.text) || extractTextFromContent(item.content);
          updateConversation(botId, (prev) => {
            const next = [...prev.messages];
            const idx = next.findIndex((m) => m.id === itemId);
            if (idx >= 0) {
              next[idx] = {
                ...next[idx],
                text: text || next[idx].text,
                streaming: false,
              };
            } else if (text) {
              next.push({ id: itemId, role: "assistant", text, turnId, streaming: false });
            }
            return { ...prev, messages: next };
          });
          if (text) {
            setBots((prev) =>
              prev.map((b) =>
                b.id === botId
                  ? {
                      ...b,
                      lastMessagePreview: text.slice(0, 120),
                      lastActiveAt: Math.floor(Date.now() / 1000),
                    }
                  : b,
              ),
            );
          }
        } else if (type && type !== "userMessage" && type !== "reasoning") {
          const activity = summarizeToolItem({ ...item, status: item.status ?? "completed" });
          updateConversation(botId, (prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.role === "assistant" && m.activities?.some((a) => a.id === activity.id)
                ? {
                    ...m,
                    activities: m.activities.map((a) => (a.id === activity.id ? activity : a)),
                  }
                : m,
            ),
          }));
        }
        return;
      }

      if (event.kind === "interactionRequested") {
        const requestId =
          (typeof payload.requestId === "string" && payload.requestId) ||
          (typeof payload.id === "string" && payload.id) ||
          "";
        if (!requestId) return;
        const interaction: BotPendingInteraction = {
          requestId,
          turnId: typeof payload.turnId === "string" ? payload.turnId : "",
          title:
            (typeof payload.title === "string" && payload.title) ||
            (typeof payload.toolName === "string" && payload.toolName) ||
            t("bots.chat.interactionTitle"),
          detail:
            (typeof payload.summary === "string" && payload.summary) ||
            (typeof payload.prompt === "string" && payload.prompt) ||
            undefined,
          argumentsDigest:
            typeof payload.argumentsDigest === "string" ? payload.argumentsDigest : undefined,
        };
        updateConversation(botId, (prev) => ({
          ...prev,
          pendingInteractions: [
            ...prev.pendingInteractions.filter((i) => i.requestId !== requestId),
            interaction,
          ],
        }));
        return;
      }

      if (event.kind === "interactionResolved") {
        const requestId =
          (typeof payload.requestId === "string" && payload.requestId) ||
          (typeof payload.id === "string" && payload.id) ||
          "";
        if (!requestId) return;
        updateConversation(botId, (prev) => ({
          ...prev,
          pendingInteractions: prev.pendingInteractions.filter((i) => i.requestId !== requestId),
        }));
        return;
      }

      if (event.kind === "turnCompleted") {
        const turnObj = isRecord(payload.turn) ? payload.turn : payload;
        const turnId =
          (typeof turnObj.id === "string" && turnObj.id) ||
          (typeof payload.turnId === "string" && payload.turnId) ||
          undefined;
        if (turnId) {
          completedTurnIdsRef.current.add(turnId);
          if (completedTurnIdsRef.current.size > 64) {
            const first = completedTurnIdsRef.current.values().next().value;
            if (first) completedTurnIdsRef.current.delete(first);
          }
        }
        const turnError = extractTurnError(turnObj) ?? extractTurnError(payload);
        setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, activeTurnId: null } : b)));
        updateConversation(botId, (prev) => {
          const next = prev.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m));
          if (turnError) {
            let targetIdx = -1;
            for (let i = next.length - 1; i >= 0; i -= 1) {
              const candidate = next[i];
              if (candidate.role === "assistant" && (!turnId || candidate.turnId === turnId)) {
                targetIdx = i;
                break;
              }
            }
            if (targetIdx >= 0) {
              next[targetIdx] = { ...next[targetIdx], streaming: false, error: turnError };
            } else {
              next.push({
                id: `${turnId ?? crypto.randomUUID()}-error`,
                role: "assistant",
                text: "",
                turnId,
                streaming: false,
                error: turnError,
              });
            }
          }
          const cleaned = next.filter(
            (m) =>
              m.role === "user" ||
              Boolean(m.text.trim()) ||
              Boolean(m.streaming) ||
              Boolean(m.error) ||
              Boolean(m.activities && m.activities.length > 0),
          );
          return { ...prev, messages: cleaned };
        });
      }
    });
  }, [refreshList, service, t, updateConversation]);

  // Auto-observe when selecting a bot that is already connected or has an active thread & Arena is ready
  const selectedBot = useMemo(
    () => bots.find((b) => b.id === selectedBotId) ?? null,
    [bots, selectedBotId],
  );
  const selectedConversation = useMemo(
    () =>
      selectedBotId ? (conversations[selectedBotId] ?? emptyConversation()) : emptyConversation(),
    [conversations, selectedBotId],
  );

  useEffect(() => {
    if (!active || !selectedBot || !service?.available()) return;
    const conv = conversations[selectedBot.id];
    if (conv?.observed || conv?.observing) return;
    if (selectedBot.connectionState.kind === "ready") {
      void observeBot(selectedBot.id, true);
    }
  }, [active, conversations, observeBot, selectedBot, service]);

  const selectBot = useCallback((id: string) => {
    setSelectedBotId(id);
    setError(null);
  }, []);

  const connectBot = useCallback(
    async (id: string) => {
      if (!service) return;
      setError(null);
      try {
        const res = await service.connect(id);
        upsertBotRecord(res.bot);
        updateConversation(id, (prev) => ({
          ...prev,
          models: res.models,
          providers: res.providers,
          providerHealth: res.providerHealth ?? res.bot.providerHealth ?? null,
        }));
        await observeBot(id, false);
      } catch (cause) {
        reportError(cause);
      }
    },
    [observeBot, reportError, service, updateConversation, upsertBotRecord],
  );

  const disconnectBot = useCallback(
    async (id: string) => {
      if (!service) return;
      setError(null);
      try {
        const res = await service.disconnect(id);
        upsertBotRecord(res.bot);
      } catch (cause) {
        reportError(cause);
      }
    },
    [reportError, service, upsertBotRecord],
  );

  const sendMessage = useCallback(
    async (id: string, rawText: string) => {
      if (!service) return false;
      const text = rawText.trim();
      if (!text) return false;
      setError(null);
      setSendingBotId(id);
      const optimisticId = `local-${crypto.randomUUID()}`;
      updateConversation(id, (prev) => ({
        ...prev,
        messages: [...prev.messages, { id: optimisticId, role: "user", text }],
      }));
      try {
        const res = await service.send(id, text);
        if (res.bot) upsertBotRecord(res.bot);
        if (res.admissionState === "unknown" || res.submissionUnknown) {
          // Keep pendingSubmission banner visible; do NOT replay!
          return true;
        }
        // If catalog hasn't been fetched yet, fetch models quietly so right pane has model list
        const conv = conversations[id];
        if (!conv || conv.models.length === 0) {
          void service
            .models(id)
            .then((m) => {
              upsertBotRecord(m.bot);
              updateConversation(id, (prev) => ({
                ...prev,
                models: m.models,
                providers: m.providers,
                providerHealth: m.providerHealth ?? m.bot?.providerHealth ?? prev.providerHealth,
              }));
            })
            .catch(() => {});
        }
        return true;
      } catch (cause) {
        // Remove optimistic user bubble on definite rejection
        updateConversation(id, (prev) => ({
          ...prev,
          messages: prev.messages.filter((m) => m.id !== optimisticId),
        }));
        reportError(cause);
        return false;
      } finally {
        setSendingBotId((cur) => (cur === id ? null : cur));
      }
    },
    [conversations, reportError, service, updateConversation, upsertBotRecord],
  );

  const reconcileBot = useCallback(
    async (id: string) => {
      if (!service) return;
      setError(null);
      setReconcilingBotId(id);
      try {
        const res = await service.reconcile(id);
        upsertBotRecord(res.bot);
        if (res.thread) {
          const timeline = extractTimelineFromThread(res.thread);
          updateConversation(id, (prev) => ({
            ...prev,
            messages: timeline.messages,
            pendingInteractions: timeline.pendingInteractions,
            observed: true,
          }));
        }
      } catch (cause) {
        reportError(cause);
      } finally {
        setReconcilingBotId((cur) => (cur === id ? null : cur));
      }
    },
    [reportError, service, updateConversation, upsertBotRecord],
  );

  const interruptBot = useCallback(
    async (id: string) => {
      if (!service) return;
      try {
        const res = await service.interrupt(id);
        upsertBotRecord(res.bot ? { ...res.bot, activeTurnId: null } : undefined);
        setBots((prev) => prev.map((b) => (b.id === id ? { ...b, activeTurnId: null } : b)));
      } catch (cause) {
        reportError(cause);
      }
    },
    [reportError, service, upsertBotRecord],
  );

  const respondInteraction = useCallback(
    async (id: string, interaction: BotPendingInteraction, decision: "approve" | "deny") => {
      if (!service) return;
      try {
        const res = await service.respondInteraction(id, interaction.requestId, {
          turnId: interaction.turnId,
          decision,
          ...(interaction.argumentsDigest ? { argumentsDigest: interaction.argumentsDigest } : {}),
        });
        upsertBotRecord(res.bot);
        updateConversation(id, (prev) => ({
          ...prev,
          pendingInteractions: prev.pendingInteractions.filter(
            (item) => item.requestId !== interaction.requestId,
          ),
        }));
      } catch (cause) {
        reportError(cause);
      }
    },
    [reportError, service, updateConversation, upsertBotRecord],
  );

  const compactBot = useCallback(
    async (id: string) => {
      if (!service) return;
      setError(null);
      try {
        const res = await service.compact(id);
        upsertBotRecord(res.bot);
      } catch (cause) {
        reportError(cause);
      }
    },
    [reportError, service, upsertBotRecord],
  );

  const resetConversation = useCallback(
    async (id: string) => {
      if (!service) return;
      setError(null);
      try {
        const res = await service.resetConversation(id);
        setRevision(res.revision);
        upsertBotRecord(res.bot);
        updateConversation(id, (prev) => ({
          ...prev,
          messages: [],
          pendingInteractions: [],
          observed: true,
        }));
      } catch (cause) {
        reportError(cause);
      }
    },
    [reportError, service, updateConversation, upsertBotRecord],
  );

  const createBot = useCallback(
    async (params: CreateBotParams) => {
      if (!service) return null;
      setError(null);
      try {
        const res = await service.create(params);
        setRevision(res.revision);
        upsertBotRecord(res.bot);
        setSelectedBotId(res.bot.id);
        return res.bot;
      } catch (cause) {
        reportError(cause);
        return null;
      }
    },
    [reportError, service, upsertBotRecord],
  );

  const updateBot = useCallback(
    async (params: UpdateBotParams) => {
      if (!service) return null;
      setError(null);
      try {
        const res = await service.update({ expectedRevision: revision, ...params });
        setRevision(res.revision);
        upsertBotRecord(res.bot);
        return res.bot;
      } catch (cause) {
        reportError(cause);
        return null;
      }
    },
    [reportError, revision, service, upsertBotRecord],
  );

  const removeBot = useCallback(
    async (id: string) => {
      if (!service) return false;
      setError(null);
      try {
        const res = await service.remove(id, revision);
        setRevision(res.revision);
        setBots((prev) => {
          const next = prev.filter((b) => b.id !== id);
          if (selectedBotIdRef.current === id) {
            setSelectedBotId(next[0]?.id ?? null);
          }
          return next;
        });
        setConversations((prev) => {
          const copy = { ...prev };
          delete copy[id];
          return copy;
        });
        return true;
      } catch (cause) {
        reportError(cause);
        return false;
      }
    },
    [reportError, revision, service],
  );

  const configureArena = useCallback(
    async (params: ConfigureArenaParams) => {
      if (!service) return false;
      setError(null);
      try {
        const res = await service.configureArena(params);
        setArena(res.arena);
        return true;
      } catch (cause) {
        reportError(cause);
        return false;
      }
    },
    [reportError, service],
  );

  const upsertProvider = useCallback(
    async (params: UpsertBotProviderParams) => {
      if (!service) return false;
      setError(null);
      try {
        const res = await service.upsertProvider(params);
        upsertBotRecord(res.bot);
        updateConversation(params.id, (prev) => ({
          ...prev,
          models: res.models,
          providers: res.providers,
          providerHealth: res.providerHealth ?? res.bot.providerHealth ?? null,
        }));
        return true;
      } catch (cause) {
        reportError(cause);
        return false;
      }
    },
    [reportError, service, updateConversation, upsertBotRecord],
  );

  return {
    available: Boolean(service?.available()),
    bots,
    revision,
    arena,
    loading,
    error,
    modelAuthorizationRequired: !!error && modelAuthorizationError,
    clearError: () => setError(null),
    selectedBot,
    selectedConversation,
    sendingBotId,
    reconcilingBotId,
    refreshList,
    selectBot,
    connectBot,
    disconnectBot,
    observeBot,
    sendMessage,
    reconcileBot,
    interruptBot,
    respondInteraction,
    compactBot,
    resetConversation,
    createBot,
    updateBot,
    removeBot,
    configureArena,
    upsertProvider,
  };
}
