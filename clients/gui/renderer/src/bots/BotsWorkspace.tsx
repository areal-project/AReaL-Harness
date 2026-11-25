import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Minimize2,
  MoreHorizontal,
  Plus,
  Power,
  RotateCcw,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { BotModelOption, BotServices } from "../host-bots.js";
import { useBotsWorkspace } from "./useBotsWorkspace.js";
import { BotAvatar, BotSidebar } from "./BotSidebar.js";
import { BotMessages } from "./BotMessages.js";
import { BotSettingsPane } from "./BotSettingsPane.js";
import { ArenaConfigDialog, CreateBotDialog } from "./BotDialogs.js";

export function BotsWorkspace({
  service,
  chrome,
  rail,
  sidebarWidth,
  onSidebarWidthChange,
  active,
  onOpenModelServices,
  drafts,
}: {
  service: BotServices | undefined;
  chrome?: React.ReactNode;
  rail: React.ReactNode;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
  active: boolean;
  onOpenModelServices?: () => void;
  drafts: Map<string, string>;
}) {
  const { t } = useI18n();
  const model = useBotsWorkspace(service, active);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [harnessModels, setHarnessModels] = useState<BotModelOption[]>([]);
  useEffect(() => {
    if (!active || !settingsOpen || !service?.harnessModels) return;
    let cancelled = false;
    void service.harnessModels().then(
      (models) => {
        if (!cancelled) setHarnessModels(models);
      },
      () => {
        if (!cancelled) setHarnessModels([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, settingsOpen, service]);
  const [expandProviderForm, setExpandProviderForm] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [arenaOpen, setArenaOpen] = useState(false);
  const [, refreshDraft] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);

  const selectedBot = model.selectedBot;
  const conversation = model.selectedConversation;
  const draft = selectedBot ? (drafts.get(selectedBot.id) ?? "") : "";
  function setDraft(id: string, text: string) {
    if (text) drafts.set(id, text);
    else drafts.delete(id);
    refreshDraft((revision) => revision + 1);
  }

  // Reset provider auto-expand when switching bots
  useEffect(() => {
    setExpandProviderForm(false);
  }, [selectedBot?.id]);

  // Auto-resize composer textarea cleanly
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft, selectedBot?.id]);

  const handleSend = async (textOverride?: string) => {
    if (!selectedBot) return;
    const text = (textOverride ?? draft).trim();
    if (!text) return;
    if (!textOverride) setDraft(selectedBot.id, "");
    const ok = await model.sendMessage(selectedBot.id, text);
    if (!ok && !textOverride && !drafts.has(selectedBot.id)) {
      setDraft(selectedBot.id, text);
    }
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (selectedBot && !selectedBot.activeTurnId && !selectedBot.pendingSubmission) {
        void handleSend();
      }
    }
  };

  const isRunning = Boolean(selectedBot?.activeTurnId);
  const isSending = selectedBot ? model.sendingBotId === selectedBot.id : false;
  const isLockedByUnknown = Boolean(selectedBot?.pendingSubmission);
  const effectiveProviderHealth =
    conversation.providerHealth ?? selectedBot?.providerHealth ?? null;
  const modelUnavailable =
    model.modelAuthorizationRequired ||
    effectiveProviderHealth?.status === "authFailed" ||
    effectiveProviderHealth?.status === "unavailable";

  return (
    <div className="bots-workspace-root" data-testid="bots-workspace">
      <BotSidebar
        chrome={chrome}
        rail={rail}
        width={sidebarWidth}
        onWidthChange={onSidebarWidthChange}
        bots={model.bots}
        selectedBotId={selectedBot?.id ?? null}
        arena={model.arena}
        onSelect={model.selectBot}
        onCreate={() => setCreateOpen(true)}
        onConfigureArena={() => setArenaOpen(true)}
      />

      <main className="bots-main">
        {!model.available ? (
          <div className="bots-center-empty">
            <Bot size={36} strokeWidth={1.5} />
            <p>{t("bots.unavailable")}</p>
          </div>
        ) : !selectedBot ? (
          <div className="bots-center-empty">
            <div className="bots-empty-icon">
              <Bot size={32} strokeWidth={1.5} />
            </div>
            <h2>{t("bots.title")}</h2>
            <p>{model.bots.length === 0 ? t("bots.emptyListHint") : t("bots.selectPrompt")}</p>
            <div className="bots-empty-actions">
              <Button onClick={() => setCreateOpen(true)} data-testid="bot-empty-create">
                <Plus size={15} />
                {t("bots.new")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="bots-stage">
            <div className="bots-chat-column">
              <header className="bot-header">
                <div className="bot-header-identity">
                  <BotAvatar avatar={selectedBot.avatar} name={selectedBot.name} size="sm" />
                  <div className="bot-header-titles">
                    <h1 className="bot-header-name" data-testid="bot-active-name">
                      {selectedBot.name}
                    </h1>
                    <span
                      className={`bot-header-status is-${modelUnavailable ? "error" : selectedBot.connectionState.kind}`}
                    >
                      <span className="bot-header-status-dot" aria-hidden="true" />
                      {modelUnavailable
                        ? t("bots.settings.providerHealthUnavailable")
                        : t(`bots.state.${selectedBot.connectionState.kind}`)}
                    </span>
                  </div>
                </div>

                <div className="bot-header-actions">
                  <Button
                    variant="ghost"
                    size="icon"
                    active={settingsOpen}
                    aria-label={t("bots.actions.settings")}
                    title={t("bots.actions.settings")}
                    aria-pressed={settingsOpen}
                    onClick={() => {
                      setExpandProviderForm(false);
                      setSettingsOpen((open) => !open);
                    }}
                    data-testid="bot-settings-toggle"
                  >
                    <SlidersHorizontal size={16} />
                  </Button>

                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("bots.actions.more")}
                          title={t("bots.actions.more")}
                        >
                          <MoreHorizontal size={16} />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      {selectedBot.connectionState.kind === "ready" ? (
                        <DropdownMenuItem onClick={() => void model.disconnectBot(selectedBot.id)}>
                          <Power size={14} />
                          {t("bots.actions.sleep")}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => void model.connectBot(selectedBot.id)}>
                          <Power size={14} />
                          {t("bots.actions.wake")}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        disabled={isLockedByUnknown}
                        onClick={() => void model.compactBot(selectedBot.id)}
                      >
                        <Minimize2 size={14} />
                        {t("bots.actions.compact")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={isLockedByUnknown}
                        onClick={() => void model.resetConversation(selectedBot.id)}
                      >
                        <RotateCcw size={14} />
                        {t("bots.actions.reset")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </header>

              {model.error && (
                <div className="bot-error-bar" role="alert" data-testid="bot-error-bar">
                  <span>{model.error}</span>
                  {onOpenModelServices && model.modelAuthorizationRequired && (
                    <Button variant="ghost" size="sm" onClick={onOpenModelServices}>
                      {t("bots.settings.openModelServices")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("common.close")}
                    onClick={model.clearError}
                  >
                    <X size={14} />
                  </Button>
                </div>
              )}

              <BotMessages
                bot={selectedBot}
                messages={conversation.messages}
                pendingInteractions={conversation.pendingInteractions}
                providerHealth={effectiveProviderHealth}
                reconciling={model.reconcilingBotId === selectedBot.id}
                onStarterPrompt={(prompt) => void handleSend(prompt)}
                onReconcile={() => void model.reconcileBot(selectedBot.id)}
                onOpenProviderSettings={() => {
                  setExpandProviderForm(true);
                  setSettingsOpen(true);
                }}
                onRespondInteraction={(interaction, decision) =>
                  void model.respondInteraction(selectedBot.id, interaction, decision)
                }
              />

              <div className="bot-composer-wrap">
                <div className="bot-composer-box">
                  <Textarea
                    ref={inputRef}
                    variant="bare"
                    rows={1}
                    value={draft}
                    disabled={isLockedByUnknown}
                    placeholder={t("bots.chat.placeholder", {
                      name: selectedBot.name,
                    })}
                    onChange={(e) => setDraft(selectedBot.id, e.target.value)}
                    onCompositionStart={() => {
                      composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      composingRef.current = false;
                    }}
                    onKeyDown={handleComposerKeyDown}
                    data-testid="bot-chat-input"
                  />
                  <div className="bot-composer-actions">
                    {isRunning ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        shape="pill"
                        className="size-8"
                        aria-label={t("bots.chat.stop")}
                        title={t("bots.chat.stop")}
                        onClick={() => void model.interruptBot(selectedBot.id)}
                        data-testid="bot-stop-button"
                      >
                        <Square size={14} />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="icon"
                        shape="pill"
                        className="size-8"
                        aria-label={t("bots.chat.send")}
                        title={t("bots.chat.send")}
                        disabled={!draft.trim() || isSending || isLockedByUnknown}
                        onClick={() => void handleSend()}
                        data-testid="bot-send-button"
                      >
                        <ArrowUp size={16} />
                      </Button>
                    )}
                  </div>
                </div>
                {selectedBot.connectionState.kind === "sleeping" && !isLockedByUnknown && (
                  <p className="bot-composer-footnote">{t("bots.banner.sleeping")}</p>
                )}
              </div>
            </div>

            {settingsOpen && (
              <BotSettingsPane
                bot={selectedBot}
                models={conversation.models}
                harnessModels={harnessModels}
                onOpenModelServices={onOpenModelServices}
                providerHealth={effectiveProviderHealth}
                expandProviderForm={expandProviderForm}
                onClose={() => setSettingsOpen(false)}
                onUpdate={model.updateBot}
                onConnect={() => model.connectBot(selectedBot.id)}
                onDisconnect={() => model.disconnectBot(selectedBot.id)}
                onCompact={() => model.compactBot(selectedBot.id)}
                onResetConversation={() => model.resetConversation(selectedBot.id)}
                onRemove={async () => {
                  const ok = await model.removeBot(selectedBot.id);
                  if (ok) setSettingsOpen(false);
                  return ok;
                }}
                onUpsertProvider={model.upsertProvider}
              />
            )}
          </div>
        )}
      </main>

      <CreateBotDialog open={createOpen} onOpenChange={setCreateOpen} onSubmit={model.createBot} />

      <ArenaConfigDialog
        open={arenaOpen}
        arena={model.arena}
        onOpenChange={setArenaOpen}
        onSubmit={model.configureArena}
      />
    </div>
  );
}
