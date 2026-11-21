import React, { useMemo, useState } from "react";
import { Bot, Cloud, CloudOff, Plus, Search, X } from "lucide-react";
import { NavigationSidebar } from "../app-shell/WorkbenchShell.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { ArenaSettingsView, BotRecord } from "../host-bots.js";

function formatRelativeTime(timestampSec: number, locale: string): string {
  if (!timestampSec) return "";
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nowSec - timestampSec);
  if (diff < 60) return locale === "zh-CN" ? "刚刚" : "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  const date = new Date(timestampSec * 1000);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function BotAvatar({
  avatar,
  name,
  size = "md",
}: {
  avatar?: string;
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const display = avatar?.trim();
  return (
    <span className={`bot-avatar bot-avatar--${size}`} aria-hidden="true">
      {display ? display : name.trim().slice(0, 1).toUpperCase() || <Bot size={16} />}
    </span>
  );
}

export function BotSidebar({
  chrome,
  rail,
  width,
  onWidthChange,
  bots,
  selectedBotId,
  arena,
  onSelect,
  onCreate,
  onConfigureArena,
}: {
  chrome?: React.ReactNode;
  rail: React.ReactNode;
  width: number;
  onWidthChange: (width: number) => void;
  bots: BotRecord[];
  selectedBotId: string | null;
  arena: ArenaSettingsView | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onConfigureArena: () => void;
}) {
  const { t, locale } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bots;
    return bots.filter(
      (bot) =>
        bot.name.toLowerCase().includes(q) ||
        bot.description.toLowerCase().includes(q) ||
        bot.lastMessagePreview.toLowerCase().includes(q) ||
        bot.workspace.toLowerCase().includes(q),
    );
  }, [bots, query]);

  return (
    <NavigationSidebar
      chrome={chrome ?? null}
      rail={rail}
      width={width}
      onWidthChange={onWidthChange}
      aria-label={t("bots.navigation.label")}
      className="bot-sidebar"
      footer={
        <div className="bot-sidebar-footer">
          <Button
            unstyled
            type="button"
            className={`bot-arena-pill ${arena?.ready ? "is-ready" : "is-unconfigured"}`}
            onClick={onConfigureArena}
            data-testid="bot-arena-config-trigger"
          >
            {arena?.ready ? <Cloud size={14} /> : <CloudOff size={14} />}
            <span>{arena?.ready ? t("bots.arena.ready") : t("bots.arena.unconfigured")}</span>
          </Button>
        </div>
      }
    >
      <div className="bot-sidebar-body">
        <div className="sidebar-workspace-header">
          <strong>{t("bots.title")}</strong>
          <div className="bot-sidebar-header-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("bots.searchPlaceholder")}
              title={t("bots.searchPlaceholder")}
              onClick={() => {
                setSearchOpen((open) => {
                  if (open) setQuery("");
                  return !open;
                });
              }}
            >
              {searchOpen ? <X size={15} /> : <Search size={15} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("bots.new")}
              title={t("bots.new")}
              onClick={onCreate}
              data-testid="bot-create-trigger"
            >
              <Plus size={16} />
            </Button>
          </div>
        </div>

        {searchOpen && (
          <div className="bot-sidebar-search">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("bots.searchPlaceholder")}
              autoFocus
            />
          </div>
        )}

        <div className="bot-list" role="listbox" aria-label={t("bots.navigation.label")}>
          {filtered.length === 0 ? (
            <div className="bot-list-empty">
              <p className="bot-list-empty-title">{t("bots.emptyList")}</p>
            </div>
          ) : (
            filtered.map((bot) => {
              const selected = bot.id === selectedBotId;
              const stateKind = bot.connectionState.kind;
              const preview = bot.lastMessagePreview || bot.description || bot.workspace;
              const time = formatRelativeTime(bot.lastActiveAt || bot.updatedAt, locale);
              return (
                <Button
                  unstyled
                  key={bot.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={`bot-row-${bot.id}`}
                  className={`bot-list-item ${selected ? "is-selected" : ""}`}
                  onClick={() => onSelect(bot.id)}
                >
                  <div className="bot-list-avatar-wrap">
                    <BotAvatar avatar={bot.avatar} name={bot.name} size="md" />
                    <span
                      className={`bot-status-dot is-${stateKind}`}
                      aria-label={t(`bots.state.${stateKind}`)}
                    />
                  </div>
                  <div className="bot-list-item-main">
                    <div className="bot-list-item-top">
                      <span className="bot-list-item-name">{bot.name}</span>
                      {time && <span className="bot-list-item-time">{time}</span>}
                    </div>
                    <p className="bot-list-item-preview">{preview}</p>
                  </div>
                </Button>
              );
            })
          )}
        </div>
      </div>
    </NavigationSidebar>
  );
}
