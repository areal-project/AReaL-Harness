import React, { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Info,
  Minimize2,
  Power,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { SettingsGroupCard, SettingsSegmentedTabs, SettingsSelect } from "@areal/ui/compositions";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type {
  BotModelOption,
  BotModelRef,
  BotProviderHealth,
  BotRecord,
  BotSystemPromptMode,
  UpdateBotParams,
  UpsertBotProviderParams,
} from "../host-bots.js";

const AVATAR_PRESETS = ["🤖", "🧠", "✨", "📋", "📅", "🛠️", "📚", "🔍", "💡", "🎯"] as const;

type ProviderProtocol = "responses" | "chatCompletions";

function encodeModelValue(ref?: BotModelRef | null): string {
  if (!ref?.modelId) return "";
  return ref.providerId ? `${ref.providerId}::${ref.modelId}` : ref.modelId;
}

function decodeModelValue(raw: string): BotModelRef | null {
  if (!raw) return null;
  const idx = raw.indexOf("::");
  if (idx >= 0) {
    return { providerId: raw.slice(0, idx), modelId: raw.slice(idx + 2) };
  }
  return { modelId: raw };
}

function previewResolvedEndpoint(rawUrl: string, protocol: ProviderProtocol): string | null {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null;
  if (protocol === "responses") {
    return trimmed.endsWith("/responses") ? trimmed : `${trimmed}/responses`;
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export function BotSettingsPane({
  bot,
  models,
  harnessModels = [],
  onOpenModelServices,
  providerHealth,
  expandProviderForm,
  onClose,
  onUpdate,
  onConnect,
  onDisconnect,
  onCompact,
  onResetConversation,
  onRemove,
  onUpsertProvider,
}: {
  bot: BotRecord;
  models: BotModelOption[];
  harnessModels?: BotModelOption[];
  onOpenModelServices?: () => void;
  providerHealth?: BotProviderHealth | null;
  expandProviderForm: boolean;
  onClose: () => void;
  onUpdate: (params: UpdateBotParams) => Promise<BotRecord | null>;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onCompact: () => Promise<void>;
  onResetConversation: () => Promise<void>;
  onRemove: () => Promise<boolean>;
  onUpsertProvider: (params: UpsertBotProviderParams) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(bot.name);
  const [avatar, setAvatar] = useState(bot.avatar);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [description, setDescription] = useState(bot.description);
  const [starterText, setStarterText] = useState(bot.starterPrompts.join("\n"));
  const [startersOpen, setStartersOpen] = useState(false);
  const [promptMode, setPromptMode] = useState<BotSystemPromptMode>(bot.systemPromptMode);
  const [preferences, setPreferences] = useState(bot.preferences);
  const savedModel =
    (bot.providerSyncMode === "hostSync" ? "harness:" : "") + encodeModelValue(bot.modelOverride);
  const [modelValue, setModelValue] = useState(savedModel);
  const usesHarnessModel = modelValue.startsWith("harness:");
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const savedCustom = bot.customProviders?.[0];
  const [providerOpen, setProviderOpen] = useState(expandProviderForm);
  const [providerId, setProviderId] = useState(savedCustom?.id || "custom");
  const [providerProtocol, setProviderProtocol] = useState<ProviderProtocol>(
    savedCustom?.protocol === "chatCompletions" ? "chatCompletions" : "responses",
  );
  const [providerBaseUrl, setProviderBaseUrl] = useState(savedCustom?.endpoint || "");
  const [providerCredentialRef, setProviderCredentialRef] = useState(
    savedCustom?.credentialRef || "",
  );
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerModelId, setProviderModelId] = useState(savedCustom?.models?.[0] || "");
  const [providerSaving, setProviderSaving] = useState(false);

  const [copiedWorkspace, setCopiedWorkspace] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    setName(bot.name);
    setAvatar(bot.avatar);
    setAvatarPickerOpen(false);
    setDescription(bot.description);
    setStarterText(bot.starterPrompts.join("\n"));
    setPromptMode(bot.systemPromptMode);
    setPreferences(bot.preferences);
    setModelValue(savedModel);
    setConfirmDelete(false);
    setSavedNotice(false);
    const custom = bot.customProviders?.[0];
    if (custom) {
      setProviderId(custom.id);
      setProviderProtocol(custom.protocol === "chatCompletions" ? "chatCompletions" : "responses");
      setProviderBaseUrl(custom.endpoint);
      setProviderCredentialRef(custom.credentialRef || "");
      setProviderModelId(custom.models?.[0] || "");
    }
  }, [
    bot.id,
    bot.name,
    bot.avatar,
    bot.description,
    bot.starterPrompts,
    bot.systemPromptMode,
    bot.preferences,
    savedModel,
    bot.customProviders,
  ]);

  useEffect(() => {
    if (expandProviderForm) setProviderOpen(true);
  }, [expandProviderForm]);

  const parsedStarters = starterText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);

  const hasChanges =
    name.trim() !== bot.name ||
    avatar.trim() !== bot.avatar ||
    description.trim() !== bot.description ||
    parsedStarters.join("\n") !== bot.starterPrompts.join("\n") ||
    promptMode !== bot.systemPromptMode ||
    preferences !== bot.preferences ||
    modelValue !== savedModel;

  const handleRevert = () => {
    setName(bot.name);
    setAvatar(bot.avatar);
    setDescription(bot.description);
    setStarterText(bot.starterPrompts.join("\n"));
    setPromptMode(bot.systemPromptMode);
    setPreferences(bot.preferences);
    setModelValue(savedModel);
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const updated = await onUpdate({
        id: bot.id,
        name: name.trim(),
        avatar: avatar.trim() || "🤖",
        description: description.trim(),
        starterPrompts: parsedStarters,
        systemPromptMode: promptMode,
        preferences,
        ...(modelValue !== savedModel
          ? ({
              modelOverride: decodeModelValue(
                usesHarnessModel ? modelValue.slice("harness:".length) : modelValue,
              ),
              providerSyncMode: usesHarnessModel ? "hostSync" : "arenaOnly",
            } as const)
          : {}),
      });
      if (updated) {
        setSavedNotice(true);
        setTimeout(() => setSavedNotice(false), 1800);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleProviderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const pid = providerId.trim();
    const endpoint = providerBaseUrl.trim();
    const mid = providerModelId.trim();
    if (!pid || !endpoint || !mid || providerSaving) return;
    setProviderSaving(true);
    try {
      const providerPayload: Record<string, unknown> = {
        id: pid,
        endpoint,
        protocol: providerProtocol,
        models: [mid],
        ...(providerCredentialRef.trim() ? { credentialRef: providerCredentialRef.trim() } : {}),
        ...(providerApiKey.trim() ? { apiKey: providerApiKey.trim() } : {}),
      };
      const ok = await onUpsertProvider({
        id: bot.id,
        provider: providerPayload,
        modelOverride: { providerId: pid, modelId: mid },
      });
      if (ok) {
        setProviderApiKey("");
        setProviderOpen(false);
      }
    } finally {
      setProviderSaving(false);
    }
  };

  const runAction = async (key: string, fn: () => Promise<unknown>) => {
    setBusyAction(key);
    try {
      await fn();
    } finally {
      setBusyAction(null);
    }
  };

  const healthStatus = providerHealth?.status ?? "unchecked";
  const supportsCredReg = providerHealth?.supportsCredentialRegistration;
  const isReady = bot.connectionState.kind === "ready";
  const resolvedEndpoint = previewResolvedEndpoint(providerBaseUrl, providerProtocol);

  return (
    <aside
      className="bot-settings-pane"
      aria-label={t("bots.settings.title")}
      data-testid="bot-settings-pane"
    >
      <div className="bot-settings-header">
        <strong className="bot-settings-header-title">{t("bots.settings.title")}</strong>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("bots.settings.close")}
          title={t("bots.settings.close")}
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </div>

      <div className="bot-settings-scroll">
        <form id="bot-settings-main-form" className="bot-settings-form" onSubmit={handleSave}>
          {/* 1. Identity Card */}
          <section className="bot-inspector-group">
            <h3 className="bot-settings-section-title">{t("bots.settings.sectionIdentity")}</h3>
            <SettingsGroupCard density="compact" className="bot-group-card">
              <div className="bot-identity-hero">
                <button
                  type="button"
                  className="bot-avatar-trigger"
                  aria-label={t("bots.settings.avatarPick")}
                  aria-expanded={avatarPickerOpen}
                  onClick={() => setAvatarPickerOpen((open) => !open)}
                >
                  <span className="bot-avatar-glyph">{avatar.trim() || "🤖"}</span>
                </button>
                <div className="bot-identity-inputs">
                  <input
                    type="text"
                    className="bot-inline-title-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                    required
                    placeholder={t("bots.settings.namePlaceholder")}
                    aria-label={t("bots.settings.name")}
                    data-testid="bot-settings-name"
                  />
                  <input
                    type="text"
                    className="bot-inline-desc-input"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={512}
                    placeholder={t("bots.settings.descriptionPlaceholder")}
                    aria-label={t("bots.settings.description")}
                  />
                </div>
              </div>

              {avatarPickerOpen && (
                <div className="bot-avatar-picker">
                  <div className="bot-avatar-preset-grid">
                    {AVATAR_PRESETS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className={`bot-avatar-preset ${avatar === emoji ? "is-selected" : ""}`}
                        onClick={() => {
                          setAvatar(emoji);
                          setAvatarPickerOpen(false);
                        }}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                  <Input
                    value={avatar}
                    onChange={(e) => setAvatar(e.target.value)}
                    maxLength={12}
                    placeholder="🤖"
                    aria-label={t("bots.settings.avatar")}
                    className="bot-avatar-custom-input"
                  />
                </div>
              )}

              <div className="bot-card-divider" />
              <div className="bot-card-row-stack">
                <button
                  type="button"
                  className="bot-row-disclosure"
                  aria-expanded={startersOpen}
                  onClick={() => setStartersOpen((open) => !open)}
                >
                  <span className="bot-row-label">{t("bots.settings.startersSummary")}</span>
                  <span className="bot-row-meta">
                    <span>
                      {parsedStarters.length > 0
                        ? t("bots.settings.startersCount", {
                            count: parsedStarters.length,
                          })
                        : t("bots.settings.startersEmpty")}
                    </span>
                    {startersOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                </button>
                {startersOpen && (
                  <div className="bot-disclosure-body">
                    <Textarea
                      value={starterText}
                      onChange={(e) => setStarterText(e.target.value)}
                      rows={3}
                      placeholder={t("bots.settings.starterPrompts")}
                      aria-label={t("bots.settings.starterPrompts")}
                    />
                  </div>
                )}
              </div>
            </SettingsGroupCard>
          </section>

          {/* 2. Persona & Behavior Card */}
          <section className="bot-inspector-group">
            <div className="bot-settings-section-head">
              <h3 className="bot-settings-section-title">
                {t("bots.settings.sectionPreferences")}
              </h3>
              <span className={`bot-sync-badge ${bot.preferencesDirty ? "is-dirty" : "is-synced"}`}>
                {bot.preferencesDirty
                  ? t("bots.settings.preferencesDirty")
                  : t("bots.settings.preferencesSynced")}
              </span>
            </div>
            <SettingsGroupCard density="compact" className="bot-group-card">
              <div className="bot-card-row">
                <span className="bot-row-label">{t("bots.settings.promptMode")}</span>
                <SettingsSegmentedTabs
                  ariaLabel={t("bots.settings.promptMode")}
                  value={promptMode}
                  onValueChange={setPromptMode}
                  items={[
                    {
                      value: "personalAgent",
                      label: t("bots.settings.promptModePersonalShort"),
                    },
                    {
                      value: "default",
                      label: t("bots.settings.promptModeDefaultShort"),
                    },
                  ]}
                />
              </div>
              <div className="bot-card-divider" />
              <div className="bot-card-row-stack">
                <div className="bot-row-label">{t("bots.settings.preferencesLabel")}</div>
                <Textarea
                  value={preferences}
                  onChange={(e) => setPreferences(e.target.value)}
                  rows={4}
                  placeholder={t("bots.settings.preferencesPlaceholder")}
                  aria-label={t("bots.settings.preferencesLabel")}
                  data-testid="bot-settings-preferences"
                  className="bot-instructions-textarea"
                />
                <p className="bot-settings-hint">{t("bots.settings.preferencesHint")}</p>
              </div>
            </SettingsGroupCard>
          </section>

          {/* 3. Model & Remote Channel Card */}
          <section className="bot-inspector-group">
            <h3 className="bot-settings-section-title">{t("bots.settings.sectionModel")}</h3>
            <SettingsGroupCard density="compact" className="bot-group-card">
              <div className="bot-card-row">
                <span className="bot-row-label">{t("bots.settings.providerStatusLabel")}</span>
                <span className={`bot-health-chip is-${healthStatus}`}>
                  {healthStatus === "ready" ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <ShieldAlert size={13} />
                  )}
                  <span>
                    {healthStatus === "ready"
                      ? t("bots.settings.providerHealthReady")
                      : healthStatus === "authFailed"
                        ? t("bots.settings.providerHealthAuthFailed")
                        : healthStatus === "unavailable"
                          ? t("bots.settings.providerHealthUnavailable")
                          : t("bots.settings.providerHealthUnchecked")}
                  </span>
                </span>
              </div>

              <div className="bot-card-divider" />
              <div className="bot-card-row bot-card-row--wrap">
                <span className="bot-row-label">{t("bots.settings.model")}</span>
                <SettingsSelect
                  aria-label={t("bots.settings.model")}
                  value={modelValue}
                  onValueChange={setModelValue}
                >
                  <option value="">{t("bots.settings.modelDefault")}</option>
                  {savedModel.startsWith("harness:") &&
                    !harnessModels.some(
                      (model) =>
                        "harness:" +
                          encodeModelValue({
                            providerId: model.providerId,
                            modelId: model.modelId ?? "",
                          }) ===
                        savedModel,
                    ) && (
                      <option value={savedModel} disabled>
                        {savedModel.slice("harness:".length)}
                      </option>
                    )}
                  {harnessModels.map((model) => {
                    const value =
                      "harness:" +
                      encodeModelValue({
                        providerId: model.providerId,
                        modelId: model.modelId ?? "",
                      });
                    return (
                      <option key={value} value={value}>
                        {t("bots.settings.harnessModelOption", {
                          model: model.displayName ?? model.modelId ?? "",
                          provider: model.providerId ?? "",
                        })}
                      </option>
                    );
                  })}
                  {models.map((item) => {
                    const mid = item.modelId || item.id || "";
                    const pid = item.providerId;
                    const val = encodeModelValue({
                      providerId: pid,
                      modelId: mid,
                    });
                    const label = item.displayName
                      ? `${item.displayName}${pid ? ` (${pid})` : ""}`
                      : pid
                        ? `${pid}/${mid}`
                        : mid;
                    return (
                      <option key={val || label} value={val}>
                        {label}
                      </option>
                    );
                  })}
                </SettingsSelect>
              </div>

              {onOpenModelServices && (
                <div className="bot-card-row-stack">
                  {usesHarnessModel && <p>{t("bots.settings.harnessAuthorization")}</p>}
                  <Button type="button" variant="ghost" size="sm" onClick={onOpenModelServices}>
                    {t("bots.settings.openModelServices")}
                  </Button>
                </div>
              )}
              {supportsCredReg === false && (healthStatus === "authFailed" || providerOpen) && (
                <>
                  <div className="bot-card-divider" />
                  <div className="bot-capability-callout" role="note">
                    <Info size={14} className="bot-capability-callout-icon" />
                    <span>{t("bots.settings.providerCredentialLimited")}</span>
                  </div>
                </>
              )}

              <div className="bot-card-divider" />
              <div className="bot-card-row-stack">
                <button
                  type="button"
                  className="bot-row-disclosure"
                  hidden={usesHarnessModel}
                  aria-expanded={providerOpen}
                  onClick={() => setProviderOpen((prev) => !prev)}
                  data-testid="bot-provider-form-toggle"
                >
                  <span className="bot-row-label">{t("bots.settings.configureProvider")}</span>
                  <span className="bot-row-meta">
                    {providerOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                </button>

                {providerOpen && !usesHarnessModel && (
                  <div className="bot-provider-sheet">
                    <div className="bot-provider-grid-2">
                      <label className="bot-field">
                        <span>{t("bots.settings.providerId")}</span>
                        <Input
                          value={providerId}
                          onChange={(e) => setProviderId(e.target.value)}
                          placeholder={t("bots.settings.providerIdPlaceholder")}
                          required
                        />
                      </label>
                      <label className="bot-field">
                        <span>{t("bots.settings.providerModelId")}</span>
                        <Input
                          value={providerModelId}
                          onChange={(e) => setProviderModelId(e.target.value)}
                          placeholder={t("bots.settings.providerModelPlaceholder")}
                          required
                        />
                      </label>
                    </div>

                    <div className="bot-field">
                      <span>{t("bots.settings.providerProtocol")}</span>
                      <SettingsSegmentedTabs
                        ariaLabel={t("bots.settings.providerProtocol")}
                        value={providerProtocol}
                        onValueChange={setProviderProtocol}
                        items={[
                          {
                            value: "responses",
                            label: t("bots.settings.providerProtocolResponses"),
                          },
                          {
                            value: "chatCompletions",
                            label: t("bots.settings.providerProtocolChat"),
                          },
                        ]}
                      />
                    </div>

                    <label className="bot-field">
                      <span>{t("bots.settings.providerBaseUrl")}</span>
                      <Input
                        value={providerBaseUrl}
                        onChange={(e) => setProviderBaseUrl(e.target.value)}
                        placeholder="https://api.openai.com/v1"
                        required
                      />
                      {resolvedEndpoint && (
                        <span className="bot-endpoint-preview">
                          {t("bots.settings.providerEndpointPreview", {
                            url: resolvedEndpoint,
                          })}
                        </span>
                      )}
                    </label>

                    {supportsCredReg === false ? (
                      <label className="bot-field">
                        <span>{t("bots.settings.providerCredentialRef")}</span>
                        <Input
                          value={providerCredentialRef}
                          onChange={(e) => setProviderCredentialRef(e.target.value)}
                          placeholder={t("bots.settings.providerCredentialRefPlaceholder")}
                        />
                      </label>
                    ) : null}

                    <label className="bot-field">
                      <span>{t("bots.settings.providerApiKey")}</span>
                      <Input
                        type="password"
                        value={providerApiKey}
                        onChange={(e) => setProviderApiKey(e.target.value)}
                        autoComplete="off"
                      />
                    </label>

                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        providerSaving ||
                        !providerId.trim() ||
                        !providerBaseUrl.trim() ||
                        !providerModelId.trim()
                      }
                      onClick={(e) => void handleProviderSubmit(e)}
                      data-testid="bot-provider-apply"
                    >
                      {t("bots.settings.providerApply")}
                    </Button>
                  </div>
                )}
              </div>
            </SettingsGroupCard>
          </section>
        </form>

        {/* 4. Sandbox & Session Card */}
        <section className="bot-inspector-group">
          <h3 className="bot-settings-section-title">{t("bots.settings.sectionSandbox")}</h3>
          <SettingsGroupCard density="compact" className="bot-group-card">
            <div className="bot-card-row">
              <span className="bot-row-label">{t("bots.settings.workspace")}</span>
              <div className="bot-workspace-chip-wrap">
                <code className="bot-workspace-code">{bot.workspace}</code>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="bot-mini-icon-btn"
                  aria-label={t("bots.settings.copyWorkspace")}
                  title={t("bots.settings.copyWorkspace")}
                  onClick={() => {
                    void navigator.clipboard?.writeText(bot.workspace).then(() => {
                      setCopiedWorkspace(true);
                      setTimeout(() => setCopiedWorkspace(false), 1400);
                    });
                  }}
                >
                  {copiedWorkspace ? <Check size={12} /> : <Copy size={12} />}
                </Button>
              </div>
            </div>

            <div className="bot-card-divider" />
            <div className="bot-card-row">
              <div className="bot-row-copy">
                <span className="bot-row-label">{t("bots.settings.connectionLabel")}</span>
                <span className="bot-row-sub">{t(`bots.state.${bot.connectionState.kind}`)}</span>
              </div>
              {isReady ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyAction !== null}
                  onClick={() => void runAction("sleep", onDisconnect)}
                >
                  <Power size={13} />
                  {t("bots.actions.sleep")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyAction !== null || bot.connectionState.kind === "waking"}
                  onClick={() => void runAction("wake", onConnect)}
                >
                  <Power size={13} />
                  {t("bots.actions.wake")}
                </Button>
              )}
            </div>

            <div className="bot-card-divider" />
            <div className="bot-card-row">
              <span className="bot-row-label">{t("bots.settings.contextLabel")}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || Boolean(bot.pendingSubmission)}
                onClick={() => void runAction("compact", onCompact)}
              >
                <Minimize2 size={13} />
                {t("bots.actions.compact")}
              </Button>
            </div>

            <div className="bot-card-divider" />
            <div className="bot-card-row">
              <div className="bot-row-copy">
                <span className="bot-row-label">{t("bots.settings.topicLabel")}</span>
                <span className="bot-row-sub">{t("bots.actions.resetHint")}</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyAction !== null || Boolean(bot.pendingSubmission)}
                onClick={() => void runAction("reset", onResetConversation)}
              >
                <RotateCcw size={13} />
                {t("bots.actions.reset")}
              </Button>
            </div>
          </SettingsGroupCard>
        </section>

        {/* 5. Danger Action */}
        <section className="bot-danger-zone">
          {!confirmDelete ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="bot-danger-button"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} />
              {t("bots.actions.delete")}
            </Button>
          ) : (
            <div className="bot-danger-confirm">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmDelete(false)}
              >
                {t("common.navigation.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busyAction !== null}
                onClick={() => void runAction("delete", onRemove)}
                data-testid="bot-delete-confirm"
              >
                {t("bots.actions.deleteConfirm")}
              </Button>
            </div>
          )}
        </section>
      </div>

      {(hasChanges || savedNotice) && (
        <div className="bot-settings-sticky-footer">
          {hasChanges ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={handleRevert}
            >
              {t("bots.settings.revert")}
            </Button>
          ) : (
            <span className="bot-saved-label">
              <CheckCircle2 size={13} />
              {t("bots.settings.saved")}
            </span>
          )}
          <Button
            type="submit"
            form="bot-settings-main-form"
            size="sm"
            disabled={!hasChanges || saving}
            data-testid="bot-settings-save"
          >
            {saving ? t("bots.settings.saving") : t("bots.settings.save")}
          </Button>
        </div>
      )}
    </aside>
  );
}
