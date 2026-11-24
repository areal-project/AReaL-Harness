import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Button } from "../components/ui/button.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { BotProviderHealth, BotRecord } from "../host-bots.js";
import type { BotChatMessage, BotPendingInteraction, BotToolActivity } from "./useBotsWorkspace.js";
import { BotAvatar } from "./BotSidebar.js";

function ToolActivityDisclosure({ activities }: { activities: BotToolActivity[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (activities.length === 0) return null;

  return (
    <div className="bot-activity-block">
      <Button
        type="button"
        variant="surface"
        size="chip"
        className="self-start"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <Wrench size={12} />
        <span>{t("bots.chat.toolActivity", { count: activities.length })}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </Button>
      {expanded && (
        <ul className="bot-activity-list">
          {activities.map((item) => (
            <li key={item.id} className={`bot-activity-item is-${item.status}`}>
              <span className="bot-activity-dot" aria-hidden="true" />
              <span className="bot-activity-label">{item.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CopyTextButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost-subtle"
      size="icon-sm"
      aria-label={copied ? t("bots.chat.copied") : t("bots.chat.copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </Button>
  );
}

export function BotMessages({
  bot,
  messages,
  pendingInteractions,
  providerHealth,
  reconciling,
  onStarterPrompt,
  onReconcile,
  onOpenProviderSettings,
  onRespondInteraction,
}: {
  bot: BotRecord;
  messages: BotChatMessage[];
  pendingInteractions: BotPendingInteraction[];
  providerHealth?: BotProviderHealth | null;
  reconciling: boolean;
  onStarterPrompt: (prompt: string) => void;
  onReconcile: () => void;
  onOpenProviderSettings: () => void;
  onRespondInteraction: (interaction: BotPendingInteraction, decision: "approve" | "deny") => void;
}) {
  const { t } = useI18n();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastTextLen = messages[messages.length - 1]?.text.length ?? 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bot.id, messages.length, lastTextLen, pendingInteractions.length]);

  const showProviderWarning =
    providerHealth &&
    (providerHealth.status === "authFailed" || providerHealth.status === "unavailable");

  return (
    <div className="bot-messages-scroll" data-testid="bot-messages">
      <div className="bot-messages-column">
        {bot.connectionState.kind === "waking" && (
          <div className="bot-banner is-info" role="status">
            <RefreshCw size={14} className="bot-spin" />
            <span>{bot.connectionState.message || t("bots.banner.waking")}</span>
          </div>
        )}

        {bot.connectionState.kind === "error" && (
          <div className="bot-banner is-danger" role="alert">
            <AlertTriangle size={14} />
            <span>{bot.connectionState.message}</span>
          </div>
        )}

        {showProviderWarning && (
          <div className="bot-banner is-warning" role="status" data-testid="bot-provider-warning">
            <ShieldAlert size={15} />
            <span className="bot-banner-text">
              {providerHealth.message ||
                (providerHealth.status === "authFailed"
                  ? t("bots.settings.providerHealthAuthFailed")
                  : t("bots.settings.providerHealthUnavailable"))}
            </span>
            <Button size="sm" variant="outline" onClick={onOpenProviderSettings}>
              {t("bots.banner.providerAction")}
            </Button>
          </div>
        )}

        {bot.pendingSubmission && (
          <div className="bot-banner is-warning" role="alert" data-testid="bot-unknown-banner">
            <AlertTriangle size={15} />
            <div className="bot-banner-stack">
              <strong>{t("bots.banner.unknownTitle")}</strong>
              <span>{t("bots.banner.unknownDesc")}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={reconciling}
              onClick={onReconcile}
              data-testid="bot-reconcile-button"
            >
              <RefreshCw size={13} className={reconciling ? "bot-spin" : undefined} />
              {reconciling ? t("bots.banner.reconciling") : t("bots.banner.reconcile")}
            </Button>
          </div>
        )}

        {messages.length === 0 ? (
          <div className="bot-empty-conversation">
            <BotAvatar avatar={bot.avatar} name={bot.name} size="lg" />
            <h2 className="bot-empty-name">{bot.name}</h2>
            <p className="bot-empty-desc">{bot.description || t("bots.chat.emptyHint")}</p>
            {bot.starterPrompts.length > 0 && (
              <div className="bot-starter-grid">
                {bot.starterPrompts.map((prompt, index) => (
                  <Button
                    key={`${index}-${prompt}`}
                    type="button"
                    variant="surface"
                    shape="pill"
                    disabled={Boolean(bot.pendingSubmission)}
                    onClick={() => onStarterPrompt(prompt)}
                  >
                    <Sparkles size={13} />
                    <span>{prompt}</span>
                  </Button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="bot-message-list">
            {messages
              .filter(
                (msg) =>
                  msg.role === "user" ||
                  Boolean(msg.text.trim()) ||
                  Boolean(msg.streaming) ||
                  Boolean(msg.error) ||
                  Boolean(msg.activities && msg.activities.length > 0),
              )
              .map((msg) =>
                msg.role === "user" ? (
                  <div key={msg.id} className="bot-msg-row is-user" data-role="user">
                    <div className="bot-user-bubble">{msg.text}</div>
                  </div>
                ) : (
                  <div key={msg.id} className="bot-msg-row is-assistant" data-role="assistant">
                    <BotAvatar avatar={bot.avatar} name={bot.name} size="sm" />
                    <div className="bot-assistant-body">
                      {msg.activities && msg.activities.length > 0 && (
                        <ToolActivityDisclosure activities={msg.activities} />
                      )}
                      {msg.text ? (
                        <div className="bot-assistant-prose">
                          <MessageResponse>{msg.text}</MessageResponse>
                        </div>
                      ) : msg.streaming ? (
                        <span className="bot-typing-indicator">{t("bots.chat.thinking")}</span>
                      ) : null}
                      {msg.error && (
                        <div
                          className="bot-assistant-error"
                          role="alert"
                          data-testid="bot-turn-error"
                        >
                          <div className="bot-assistant-error-head">
                            <AlertTriangle size={14} />
                            <strong>{t("bots.chat.turnFailed")}</strong>
                          </div>
                          <p className="bot-assistant-error-detail">{msg.error}</p>
                          {/401|403|unauthori|auth|provider|model|http/i.test(msg.error) && (
                            <div className="bot-assistant-error-actions">
                              <Button size="sm" variant="outline" onClick={onOpenProviderSettings}>
                                {t("bots.chat.checkProvider")}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                      {!msg.streaming && msg.text && (
                        <div className="bot-msg-toolbar">
                          <CopyTextButton text={msg.text} />
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
          </div>
        )}

        {pendingInteractions.map((interaction) => (
          <div
            key={interaction.requestId}
            className="bot-interaction-card"
            data-testid={`bot-interaction-${interaction.requestId}`}
          >
            <div className="bot-interaction-header">
              <strong>{interaction.title || t("bots.chat.interactionTitle")}</strong>
              {interaction.detail && <p>{interaction.detail}</p>}
            </div>
            <div className="bot-interaction-actions">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRespondInteraction(interaction, "deny")}
              >
                {t("bots.chat.deny")}
              </Button>
              <Button size="sm" onClick={() => onRespondInteraction(interaction, "approve")}>
                {t("bots.chat.approve")}
              </Button>
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
