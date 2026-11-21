import React, { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { ArenaSettingsView, ConfigureArenaParams, CreateBotParams } from "../host-bots.js";

const BOT_TEMPLATE_IDS = [
  {
    id: "weekly",
    avatar: "📝",
    nameKey: "bots.templates.weekly.name",
    descriptionKey: "bots.templates.weekly.description",
    preferencesKey: "bots.templates.weekly.preferences",
    starterKeys: ["bots.templates.weekly.starter1", "bots.templates.weekly.starter2"],
  },
  {
    id: "planner",
    avatar: "🗓️",
    nameKey: "bots.templates.planner.name",
    descriptionKey: "bots.templates.planner.description",
    preferencesKey: "bots.templates.planner.preferences",
    starterKeys: ["bots.templates.planner.starter1", "bots.templates.planner.starter2"],
  },
  {
    id: "memory",
    avatar: "🧠",
    nameKey: "bots.templates.memory.name",
    descriptionKey: "bots.templates.memory.description",
    preferencesKey: "bots.templates.memory.preferences",
    starterKeys: ["bots.templates.memory.starter1", "bots.templates.memory.starter2"],
  },
] as const;

export function CreateBotDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (params: CreateBotParams) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("🤖");
  const [description, setDescription] = useState("");
  const [preferences, setPreferences] = useState("");
  const [starterPrompts, setStarterPrompts] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setAvatar("🤖");
    setDescription("");
    setPreferences("");
    setStarterPrompts([]);
    setWorkspace("");
    setSubmitting(false);
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const created = await onSubmit({
        name: name.trim(),
        avatar: avatar.trim() || "🤖",
        description: description.trim(),
        preferences,
        starterPrompts,
        systemPromptMode: "personalAgent",
        ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
      });
      if (created) onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bot-dialog" data-testid="bot-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("bots.create.title")}</DialogTitle>
          <DialogDescription>{t("bots.create.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="bot-template-strip">
          <span className="bot-template-label">{t("bots.create.templates")}</span>
          <div className="bot-template-chips">
            {BOT_TEMPLATE_IDS.map((tpl) => {
              const tplName = t(tpl.nameKey);
              return (
                <Button
                  key={tpl.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  shape="pill"
                  onClick={() => {
                    setName(tplName);
                    setAvatar(tpl.avatar);
                    setDescription(t(tpl.descriptionKey));
                    setPreferences(t(tpl.preferencesKey));
                    setStarterPrompts(tpl.starterKeys.map((key) => t(key)));
                  }}
                >
                  <span>{tpl.avatar}</span>
                  <span>{tplName}</span>
                </Button>
              );
            })}
          </div>
        </div>

        <form className="bot-dialog-form" onSubmit={handleSubmit}>
          <div className="bot-settings-row-pair">
            <label className="bot-field bot-field-avatar">
              <span>{t("bots.settings.avatar")}</span>
              <Input value={avatar} onChange={(e) => setAvatar(e.target.value)} maxLength={12} />
            </label>
            <label className="bot-field bot-field-grow">
              <span>{t("bots.settings.name")}</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                required
                autoFocus
                data-testid="bot-create-name"
              />
            </label>
          </div>
          <label className="bot-field">
            <span>{t("bots.settings.description")}</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={512}
            />
          </label>
          <label className="bot-field">
            <span>{t("bots.settings.sectionPreferences")}</span>
            <Textarea
              value={preferences}
              onChange={(e) => setPreferences(e.target.value)}
              rows={3}
              placeholder={t("bots.settings.preferencesPlaceholder")}
            />
          </label>
          <label className="bot-field">
            <span>{t("bots.create.workspaceOptional")}</span>
            <Input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder={t("bots.create.workspacePlaceholder")}
            />
          </label>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.navigation.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || submitting}
              data-testid="bot-create-submit"
            >
              {submitting ? t("bots.create.creating") : t("bots.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ArenaConfigDialog({
  open,
  arena,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  arena: ArenaSettingsView | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (params: ConfigureArenaParams) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [baseUrl, setBaseUrl] = useState(arena?.baseUrl ?? "");
  const [profile, setProfile] = useState(arena?.profile ?? "prod");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBaseUrl(arena?.baseUrl ?? "");
    setProfile(arena?.profile ?? "prod");
    setToken("");
    setSaving(false);
  }, [arena, open]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const ok = await onSubmit({
        baseUrl: baseUrl.trim() || null,
        profile: profile.trim() || null,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      if (ok) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const handleClearToken = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSubmit({ clearToken: true });
      setToken("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bot-dialog" data-testid="bot-arena-dialog">
        <DialogHeader>
          <DialogTitle>{t("bots.arena.title")}</DialogTitle>
          <DialogDescription>{t("bots.arena.subtitle")}</DialogDescription>
        </DialogHeader>

        <form className="bot-dialog-form" onSubmit={handleSave}>
          <label className="bot-field">
            <span>{t("bots.arena.baseUrl")}</span>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("bots.arena.baseUrlPlaceholder")}
            />
          </label>

          <label className="bot-field">
            <span>{t("bots.arena.profile")}</span>
            <Input
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              placeholder={t("bots.arena.profilePlaceholder")}
            />
            <span className="bot-settings-hint">{t("bots.arena.profileHint")}</span>
          </label>

          <label className="bot-field">
            <span>{t("bots.arena.token")}</span>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                arena?.hasToken ? t("bots.arena.tokenConfigured") : t("bots.arena.tokenPlaceholder")
              }
              autoComplete="off"
              data-testid="bot-arena-token-input"
            />
            {arena?.tokenSource === "host" && (
              <span className="bot-settings-hint">{t("bots.arena.sourceHost")}</span>
            )}
            {arena?.tokenSource === "toml" && (
              <span className="bot-settings-hint">{t("bots.arena.sourceToml")}</span>
            )}
          </label>

          <DialogFooter>
            {arena?.tokenSource === "host" && (
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => void handleClearToken()}
              >
                {t("bots.arena.clearToken")}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.navigation.cancel")}
            </Button>
            <Button type="submit" disabled={saving} data-testid="bot-arena-save">
              {saving ? t("bots.settings.saving") : t("bots.settings.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
