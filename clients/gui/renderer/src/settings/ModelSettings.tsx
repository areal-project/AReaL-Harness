import { withDefaultModelCapabilities } from "@areal/provider-config";
import { useI18n, UiMessageError } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useSettingsOperation } from "./useSettingsOperation.js";
import { useDraftBlocker, useGuardedNavigation } from "./UnsavedChanges.js";
import { ModelEditor } from "./ModelEditor.js";
import { ChatGPTSubscription, subscriptionStatusLabel } from "./ChatGPTSubscription.js";
import { useEffect, useState } from "react";
import {
  Pencil,
  Trash2,
  Unplug,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { DialogFooter } from "../components/ui/dialog.js";
import { EmptySettings, Feedback, SettingsDialog, useResource } from "./common.js";
import {
  discoveredModels,
  newConnectionDraft,
  subscriptionProjection,
} from "./provider-ui-state.js";
import { ProviderTemplatePicker } from "./ProviderTemplatePicker.js";
import {
  ProviderApiKeySection,
  ProviderBaseUrlSection,
} from "./model-provider-section/ProviderCardSections.js";
import { ProviderApiFormatSelect } from "./model-provider-section/ProviderApiFormatSelect.js";
import { useApiKeyReveal } from "./useApiKeyReveal.js";
import { useProviderDiscovery, type DiscoveryConnection } from "./useProviderDiscovery.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu.js";
import "./ModelSettings.css";
import type { Action, CommandParams, Data } from "../services.js";

const CHATGPT = "chatgpt";
export function ModelSettings({
  action,
  subscription,
  onOpenSessionSettings,
}: {
  action: Action;
  subscription?: Data;
  onOpenSessionSettings: () => void;
}) {
  const { t } = useI18n();
  const navigate = useGuardedNavigation();
  const api = <P extends CommandParams<"providers">>(request: P) => action("providers", request);
  const state = useResource(() => api({ operation: "list" }), "application");
  const [loadedSubscription, setLoadedSubscription] = useState<Data>();
  const account = subscription ?? loadedSubscription;
  const accountModels: Data[] = account?.models ?? [];
  const accountStatus = account;
  const accountEnabled = account?.authenticated === true;
  const accountReady = subscriptionProjection(account).canTest;
  const accountLabel = accountStatus
    ? t("settings.chatGPTSubscription.valueSubscriptionValue", {
        value0: accountStatus.email || "ChatGPT",
        value1: subscriptionStatusLabel(t, accountStatus.state),
      })
    : "";
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState<Data | null>(null);
  const [key, setKey] = useState<string | undefined>();
  const [keyVisible, setKeyVisible] = useState(false);
  const { busy, error, message, setError, setMessage, run, execute } = useSettingsOperation();
  const [remove, setRemove] = useState<Data | null>(null);
  const [modelDraft, setModelDraft] = useState<{ model: Data; index: number } | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [probe, setProbe] = useState<Data>({});
  const items: Data[] = state.value?.data ?? [];
  const provider = draft ?? items.find((p) => p.id === selected);
  const authentication = provider?.authentication ?? (provider?.apiKeyEnv ? "apiKey" : "none");
  const reveal = useApiKeyReveal(
    action,
    !picker && authentication === "apiKey" ? provider?.id : undefined,
    state.value?.revision,
  );
  let discoveryConnection: DiscoveryConnection | null = null;
  if (provider && ["chatCompletions", "responses"].includes(provider.protocol)) {
    try {
      const url = new URL(provider.baseUrl);
      const credential: DiscoveryConnection["credential"] | null =
        authentication === "none"
          ? { kind: "none" }
          : key?.trim()
            ? { kind: "draft", value: key }
            : provider.id && state.value?.credentialStates?.[provider.id] === "available"
              ? {
                  kind: "saved",
                  providerId: provider.id,
                  expectedRevision: draft?.basedOnRevision ?? state.value.revision,
                }
              : null;
      if (
        credential &&
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        discoveryConnection = {
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          credential,
        };
    } catch {}
  }
  const discovery = useProviderDiscovery(action, discoveryConnection);
  const visibleModels = (provider?.models ?? [])
    .map((model: Data, index: number) => ({ model, index }))
    .filter(({ model }: { model: Data }) =>
      `${model.displayName ?? ""} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase()),
    );
  const edit = (patch: Data) => {
    setDraft({
      ...provider,
      ...patch,
      basedOnRevision: draft?.basedOnRevision ?? state.value?.revision,
    });
    setMessage("");
  };
  const editConnection = (patch: Data) => {
    discovery.invalidate(true);
    setChecked([]);
    edit(patch);
  };
  const select = (item: Data) => {
    reveal.reset();
    discovery.invalidate();
    setChecked([]);
    setSelected(item.id);
    setPicker(false);
    setDraft(null);
    setKey(undefined);
    setKeyVisible(false);
    setModelQuery("");
    setError("");
    setMessage("");
  };
  const choose = (id: string) => navigate(() => select({ id }));
  const save = async (candidate = provider, apiKey = key) => {
    if (!candidate) throw new UiMessageError({ id: "settings.modelSettings.noProviderToSave" });
    let result: Data;
    try {
      result = await api({
        operation: "save",
        expectedRevision: candidate.basedOnRevision ?? state.value?.revision,
        provider: {
          id: candidate.id,
          name: candidate.name,
          baseUrl: candidate.baseUrl,
          protocol: candidate.protocol,
          enabled: candidate.enabled,
          models: candidate.models,
          parameters: candidate.parameters,
        },
        authentication: candidate.authentication ?? (candidate.apiKeyEnv ? "apiKey" : "none"),
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
    } catch (cause) {
      await state.refresh();
      throw cause;
    }
    const saved = candidate.id
      ? result.data.find((p: Data) => p.id === candidate.id)
      : result.data.at(-1);
    state.accept(result);
    select(saved);
    setProbe({});
    return saved;
  };
  const baseline = items.find((item) => item.id === selected);
  const apiKeyConfigured =
    !!provider?.id && state.value?.credentialStates?.[provider.id] === "available";
  // 开关与输入框是草稿；状态只投影 Core 的已保存目录和凭据诊断。
  const savedStatus = (item?: Data) =>
    !item
      ? t("settings.modelSettings.unsaved")
      : !item.enabled
        ? t("settings.modelSettings.disabled")
        : state.value?.credentialStates?.[item.id] === "unavailable"
          ? t("settings.modelSettings.missingCredentials")
          : t("settings.modelSettings.available");
  const dirty =
    key !== undefined ||
    (draft !== null &&
      (!baseline ||
        Object.keys(draft).some(
          (field) =>
            field !== "basedOnRevision" &&
            JSON.stringify(draft[field]) !==
              JSON.stringify(
                field === "authentication"
                  ? baseline.apiKeyEnv
                    ? "apiKey"
                    : "none"
                  : baseline[field],
              ),
        )));
  const discard = () => {
    reveal.reset();
    discovery.invalidate();
    setChecked([]);
    setDraft(null);
    setKey(undefined);
    setKeyVisible(false);
    setError("");
  };
  useDraftBlocker({
    label: { id: "settings.modelSettings.provider" },
    dirty,
    busy,
    discard,
    save: () =>
      execute(async () => {
        await save();
      }),
  });
  const saveThen = (task: (saved: Data) => Promise<void>) =>
    run(async () => {
      const saved = draft || key !== undefined ? await save() : provider;
      await task(saved);
    });
  const current =
    selected ??
    (accountEnabled ? CHATGPT : (items.find((item) => item.enabled)?.id ?? items[0]?.id ?? null));
  useEffect(() => {
    // 初始选择只决定一次；账号临时状态变化不能把用户移到另一份连接配置。
    if (selected === null && !picker && state.value && accountStatus)
      setSelected(
        accountEnabled
          ? CHATGPT
          : (items.find((item) => item.enabled)?.id ?? items[0]?.id ?? CHATGPT),
      );
  }, [selected, picker, state.value, accountStatus, accountEnabled]);
  const application = state.value?.application;
  const waitingForApplication = application?.kind === "deferred" || application?.kind === "unknown";
  useEffect(() => {
    if (!waitingForApplication || busy) return;
    let stopped = false;
    let timer = setTimeout(async function refresh() {
      await state.refresh();
      if (!stopped) timer = setTimeout(refresh, 2000);
    }, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waitingForApplication, busy, state.refresh]);
  const applicationMessage = !state.value
    ? ""
    : application?.kind === "unknown"
      ? t("settings.modelSettings.savedUnconfirmed")
      : application?.kind === "failed"
        ? t("settings.modelSettings.savedFailed")
        : application?.kind === "deferred"
          ? t(
              application.reason === "disconnected"
                ? "settings.modelSettings.savedDisconnected"
                : "settings.modelSettings.savedDeferred",
            )
          : application?.kind === "applied" && !dirty
            ? t("settings.modelSettings.savedAndApplied")
            : application?.kind === "saved" && !dirty
              ? t("settings.modelSettings.saved")
              : "";
  const refreshCatalog = () =>
    navigate(() => {
      discard();
      void state.refresh();
    });
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const catalog = [
    { id: CHATGPT, name: "ChatGPT", enabled: accountEnabled },
    ...items.map((item) => ({
      id: item.id as string,
      name: item.name as string,
      enabled: !!item.enabled,
    })),
  ].filter((item) => matches(item.name));
  const enabled = catalog.filter((item) => item.enabled);
  const disabled = catalog.filter((item) => !item.enabled);
  const overrides = Object.entries(state.value?.effective?.sources ?? {}).filter(
    ([field, source]) =>
      field.startsWith("model.") && ["env", "cli"].includes((source as Data).kind),
  );
  const defaultModel = state.value?.defaultModel;
  const isDefault = (providerId: string, modelId: string) =>
    defaultModel?.providerId === providerId && defaultModel?.modelId === modelId;
  const changeDefault = (providerId: string, modelId: string) =>
    run(async () => {
      try {
        state.accept(
          await api({
            operation: "defaultAndApply",
            expectedRevision: state.value?.revision,
            model: { providerId, modelId },
          }),
        );
      } catch (cause) {
        await state.refresh();
        throw cause;
      }
    });
  const subscriptionModels = accountModels.filter((model) =>
    `${model.displayName ?? model.name ?? ""} ${model.id}`
      .toLowerCase()
      .includes(modelQuery.toLowerCase()),
  );
  const modelSearch = (
    <SettingsSearchInput
      placeholder={t("settings.modelSettings.searchModelNameOrID")}
      aria-label={t("settings.modelSettings.searchModelNameOrID")}
      value={modelQuery}
      onChange={(e) => setModelQuery(e.target.value)}
      onClear={() => setModelQuery("")}
      clearLabel={t("settings.modelSettings.clearModelSearch")}
      containerClassName="provider-model-search"
    />
  );
  return (
    <div className="model-settings">
      <Feedback
        error={
          state.error ||
          error ||
          reveal.error ||
          (application?.kind === "failed" ? application.message : "")
        }
        message={message}
      />
      <div
        className="provider-settings"
        data-provider={current === CHATGPT && !picker ? CHATGPT : "custom"}
      >
        <aside
          className="provider-navigation"
          aria-label={t("settings.modelSettings.providerCatalog")}
        >
          <div className="provider-navigation-top">
            <h2>{t("settings.modelSettings.provider")}</h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("settings.modelSettings.refreshProviders")}
              disabled={busy || state.loading}
              onClick={refreshCatalog}
            >
              <RefreshCw size={16} />
            </Button>
          </div>
          <SettingsSearchInput
            placeholder={t("settings.modelSettings.searchProviders")}
            aria-label={t("settings.modelSettings.searchProviders")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            clearLabel={t("settings.modelSettings.clearSearch")}
          />

          <div className="provider-catalog">
            {[
              ["enabled", t("settings.modelSettings.enabled"), enabled],
              ["disabled", t("settings.modelSettings.notEnabled"), disabled],
            ].map(([id, label, group]) =>
              (group as typeof catalog).length ? (
                <section key={id as string}>
                  <p className="provider-catalog-label">{label as string}</p>
                  {(group as typeof catalog).map((item) => (
                    <Button
                      unstyled
                      data-slot={undefined}
                      type="button"
                      className="provider-catalog-row"
                      key={item.id}
                      aria-current={current === item.id}
                      data-enabled={item.enabled}
                      disabled={busy}
                      onClick={() => choose(item.id)}
                    >
                      <span className="provider-catalog-dot" aria-hidden="true" />
                      <span>{item.name}</span>
                    </Button>
                  ))}
                </section>
              ) : null,
            )}
            {!catalog.length && (
              <p className="settings-muted provider-list-empty">
                {state.loading
                  ? t("settings.modelSettings.loadingProviders")
                  : query
                    ? t("settings.modelSettings.noMatchingProviders")
                    : t("settings.modelSettings.noProvidersAdded")}
              </p>
            )}
          </div>
          <Button
            className="provider-catalog-add"
            variant="outline"
            disabled={busy}
            onClick={() =>
              navigate(() => {
                discard();
                setPicker(true);
                setSelected(null);
                setMessage("");
              })
            }
          >
            {t("settings.modelSettings.addProvider")}
          </Button>
        </aside>
        <div className="provider-detail">
          <div
            className="provider-file-status"
            role="status"
            aria-label={t("settings.modelSettings.configurationStatus")}
          >
            {busy
              ? t("settings.modelSettings.saving")
              : !state.value
                ? t("settings.modelSettings.loading")
                : applicationMessage}
            {application?.kind === "failed" && (
              <Button
                variant="link"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    try {
                      state.accept(
                        await api({ operation: "apply", expectedRevision: state.value?.revision }),
                      );
                    } finally {
                      await state.refresh();
                    }
                  })
                }
              >
                {t("settings.modelSettings.retryApply")}
              </Button>
            )}
          </div>
          {overrides.length > 0 && (
            <p className="settings-muted" role="status">
              {t("settings.modelSettings.commandLineOrEnvironmentSettingsOverrideFile")}
              {overrides
                .map(
                  ([field, source]) =>
                    `${field}：${(source as Data).name ?? (source as Data).flag}`,
                )
                .join(" ")}
            </p>
          )}
          {picker && (
            <ProviderTemplatePicker
              disabled={busy}
              onBack={() => choose(current ?? CHATGPT)}
              onCreate={(definition) => {
                if (definition.subscription) {
                  choose(CHATGPT);
                  return;
                }
                const authentication = definition.authMethods?.includes("apiKey")
                  ? "apiKey"
                  : "none";
                discovery.invalidate(true);
                setChecked([]);
                setSelected("");
                setDraft(newConnectionDraft(definition, authentication, state.value?.revision));
                setKey(authentication === "apiKey" ? "" : undefined);
                setKeyVisible(false);
                setPicker(false);
                setError("");
                setMessage("");
              }}
            />
          )}
          <div hidden={picker || (current !== CHATGPT && !provider)}>
            <header className="provider-detail-heading">
              <div>
                <h2>
                  {current === CHATGPT
                    ? "ChatGPT"
                    : provider?.name || t("settings.modelSettings.newProvider")}
                </h2>
                <p
                  className="settings-muted"
                  role="status"
                  aria-label={t("settings.modelSettings.providerStatus")}
                >
                  {current === CHATGPT
                    ? accountLabel || t("settings.modelSettings.loadingSubscriptionStatus")
                    : savedStatus(baseline)}
                </p>
              </div>
              {current !== CHATGPT && provider && (
                <label className="provider-enable-control">
                  {t("settings.modelSettings.enable")}
                  <Switch
                    disabled={busy}
                    aria-label={t("settings.modelSettings.enableProvider")}
                    checked={provider.enabled}
                    onCheckedChange={(enabled) => edit({ enabled })}
                  />
                </label>
              )}
            </header>
            <div hidden={current !== CHATGPT} className="chatgpt-subscription-panel">
              <ChatGPTSubscription
                action={action}
                status={subscription}
                onStatusChange={setLoadedSubscription}
              />
            </div>
            {current === CHATGPT ? (
              <div className="provider-model-section">
                <div className="provider-connection-summary">
                  <span>{accountLabel || t("settings.modelSettings.chatgptSubscription")}</span>
                </div>
                <h3>{t("settings.modelSettings.modelCount", { count: accountModels.length })}</h3>
                {modelSearch}
                <div
                  className="subscription-model-list provider-model-scroll"
                  aria-label={t("settings.modelSettings.chatgptModels")}
                >
                  {subscriptionModels.map((model) => (
                    <div key={model.id} className="provider-model-row">
                      <div className="provider-model-label">
                        <strong>{model.displayName || model.name || model.id}</strong>
                      </div>
                      {isDefault("areal_openai", model.id) && (
                        <span className="provider-model-default">
                          {t("settings.modelSettings.fallbackDefault")}
                        </span>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("settings.modelSettings.moreActionsForModelValue", {
                                value0: model.displayName || model.name || model.id,
                              })}
                              disabled={busy}
                            />
                          }
                        >
                          <MoreHorizontal size={16} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={busy || !accountReady || isDefault("areal_openai", model.id)}
                            onClick={() => void changeDefault("areal_openai", model.id)}
                          >
                            {t("settings.modelSettings.setAsFallbackDefault")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                  {!subscriptionModels.length && (
                    <p className="settings-muted provider-list-empty">
                      {modelQuery
                        ? t("settings.modelSettings.noMatchingModels")
                        : accountReady
                          ? t("settings.modelSettings.noModelsAvailableForThisAccount")
                          : t("settings.modelSettings.signInOrRefreshYourAccountIn")}
                    </p>
                  )}
                </div>
              </div>
            ) : provider ? (
              <fieldset disabled={busy} className="provider-inline provider-connection-form">
                <div>
                  <label className="mb-1 block text-ui-base text-foreground-subtle">
                    {t("settings.modelProvider.apiFormat")}
                  </label>
                  <ProviderApiFormatSelect
                    value={provider.protocol}
                    onChange={(protocol) => editConnection({ protocol })}
                  />
                </div>
                <div className="provider-name-field">
                  <label className="settings-muted" htmlFor="provider-name">
                    {t("settings.modelSettings.providerName")}
                  </label>
                  <div className="provider-name-control">
                    <Input
                      id="provider-name"
                      aria-label={t("settings.modelSettings.providerName")}
                      size="lg"
                      value={provider.name}
                      onChange={(event) => edit({ name: event.target.value })}
                      className="flex-1 font-semibold"
                    />
                    {provider.id && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("settings.modelSettings.removeValue", {
                          value0: provider.name,
                        })}
                        onClick={() => navigate(() => setRemove(provider))}
                      >
                        <Trash2 size={16} />
                      </Button>
                    )}
                  </div>
                </div>
                <ProviderBaseUrlSection
                  baseUrlValue={provider.baseUrl}
                  onBaseUrlChange={(baseUrl) => editConnection({ baseUrl })}
                  onBaseUrlBlur={() => {}}
                />
                <div>
                  <span className="mb-1 block text-ui-base text-foreground-subtle">
                    {t("settings.modelSettings.authentication")}
                  </span>
                  <SettingsSelect
                    aria-label={t("settings.modelSettings.authentication")}
                    value={authentication}
                    onValueChange={(value) => {
                      reveal.reset();
                      setKeyVisible(false);
                      editConnection({ authentication: value as "apiKey" | "none" });
                      setError("");
                      if (value === "none") setKey(undefined);
                    }}
                  >
                    <option value="apiKey">API Key</option>
                    <option value="none">{t("settings.modelSettings.noAuthentication")}</option>
                  </SettingsSelect>
                </div>
                {authentication === "apiKey" && (
                  <div>
                    <ProviderApiKeySection
                      apiKeyConfigured={apiKeyConfigured}
                      apiKeyLoading={reveal.loading}
                      apiKeyValue={key || reveal.value}
                      apiKeyVisible={key ? keyVisible : !!reveal.value}
                      onApiKeyChange={(value) => {
                        reveal.reset();
                        setKey(value);
                        editConnection({});
                      }}
                      onToggleApiKeyVisibility={() => {
                        if (key) setKeyVisible(!keyVisible);
                        else {
                          setKeyVisible(false);
                          void reveal.toggle();
                        }
                      }}
                      onApiKeyBlur={() => {}}
                    />
                  </div>
                )}
                <div className="provider-model-section">
                  <div className="provider-connection-summary">
                    <span>
                      {dirty
                        ? t("settings.modelSettings.unsavedChanges")
                        : t("settings.modelSettings.connectionConfigured")}
                    </span>
                    <Button
                      variant="outline"
                      disabled={
                        busy || !provider.enabled || !provider.models.some((m: Data) => m.enabled)
                      }
                      onClick={() =>
                        void saveThen(async (saved) => {
                          const model = saved.models.find((m: Data) => m.enabled);
                          await api({ operation: "probe", id: saved.id, model: model.id });
                          setProbe((p) => ({ ...p, [model.id]: true }));
                          setMessage({
                            id: "settings.modelSettings.connectedToModelValue",
                            values: { value0: model.id },
                          });
                        })
                      }
                    >
                      {t("settings.modelSettings.testConnection")}
                    </Button>
                  </div>
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-ui-base text-foreground-subtle">
                      {t("settings.modelSettings.modelCount", { count: provider.models.length })}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        disabled={!discoveryConnection || discovery.state.kind === "loading"}
                        onClick={() => {
                          setChecked([]);
                          discovery.refresh();
                        }}
                      >
                        {t("settings.modelSettings.fetchModels")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          setModelDraft({
                            model: withDefaultModelCapabilities(
                              { id: "", enabled: true, parameters: {} },
                              provider.parameters,
                            ),
                            index: -1,
                          })
                        }
                      >
                        {t("settings.modelSettings.addModel")}
                      </Button>
                    </div>
                  </div>
                  {discovery.state.kind === "loading" && (
                    <p className="settings-muted" role="status">
                      {t("settings.modelSettings.fetchingModels")}
                    </p>
                  )}
                  {discovery.state.kind === "failed" && (
                    <p className="settings-error" role="alert">
                      {discovery.state.message}
                    </p>
                  )}
                  {discovery.state.kind === "ready" && (
                    <div
                      className="provider-discovered-models"
                      aria-label={t("settings.modelSettings.selectModels")}
                    >
                      <p className="settings-muted">
                        {t(
                          discovery.state.models.length
                            ? "settings.modelSettings.chooseModelsToAddFromTheService"
                            : "settings.modelSettings.emptyDiscovery",
                        )}
                      </p>
                      {discovery.state.models.map((id) => (
                        <label key={id}>
                          <Input
                            unstyled
                            data-slot={undefined}
                            type="checkbox"
                            disabled={provider.models.some((model: Data) => model.id === id)}
                            checked={
                              checked.includes(id) ||
                              provider.models.some((model: Data) => model.id === id)
                            }
                            onChange={(event) =>
                              setChecked(
                                event.target.checked
                                  ? [...checked, id]
                                  : checked.filter((value) => value !== id),
                              )
                            }
                          />
                          {id}
                        </label>
                      ))}
                      {discovery.state.models.length > 0 && (
                        <Button
                          variant="secondary"
                          disabled={!checked.length}
                          onClick={() => {
                            const result = discovery.state;
                            if (result.kind !== "ready") return;
                            edit({
                              models: [
                                ...provider.models,
                                ...discoveredModels(provider, checked, result.modelParameters),
                              ],
                            });
                            setChecked([]);
                          }}
                        >
                          {t("settings.modelSettings.addSelectedModels")}
                        </Button>
                      )}
                    </div>
                  )}
                  {modelSearch}
                  {provider.models.length ? (
                    <div className="provider-model-scroll overflow-hidden rounded-lg border border-input-border bg-input">
                      {visibleModels.map(({ model, index }: { model: Data; index: number }) => (
                        <div
                          key={`${model.id}:${index}`}
                          className="provider-model-row flex items-center gap-2 px-3 py-2 border-b border-input-border last:border-b-0"
                        >
                          <div className="min-w-0 flex-1 provider-model-label">
                            <strong>{model.displayName || model.id}</strong>
                            {model.displayName && model.displayName !== model.id && (
                              <small>{model.id}</small>
                            )}
                          </div>
                          {isDefault(provider.id, model.id) && (
                            <span className="provider-model-default">
                              {t("settings.modelSettings.fallbackDefault")}
                            </span>
                          )}
                          {probe[model.id] && (
                            <small>{t("settings.modelSettings.connected")}</small>
                          )}
                          <Switch
                            disabled={busy}
                            size="sm"
                            aria-label={t("settings.modelSettings.enableModelValue", {
                              value0: model.id,
                            })}
                            checked={model.enabled}
                            onCheckedChange={(enabled) =>
                              edit({
                                models: provider.models.map((m: Data, i: number) =>
                                  i === index ? { ...m, enabled } : m,
                                ),
                              })
                            }
                          />
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={t("settings.modelSettings.moreActionsForModelValue", {
                                    value0: model.displayName || model.id,
                                  })}
                                  disabled={busy}
                                />
                              }
                            >
                              <MoreHorizontal size={16} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                aria-label={t("settings.modelSettings.testModelValue", {
                                  value0: model.id,
                                })}
                                disabled={busy || !provider.enabled || !model.enabled}
                                onClick={() =>
                                  void saveThen(async (saved) => {
                                    await api({
                                      operation: "probe",
                                      id: saved.id,
                                      model: model.id,
                                    });
                                    setProbe((p) => ({ ...p, [model.id]: true }));
                                    setMessage({
                                      id: "settings.modelSettings.connectedToModelValue",
                                      values: { value0: model.id },
                                    });
                                  })
                                }
                              >
                                <Unplug size={14} />
                                {t("settings.modelSettings.testConnection")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={
                                  busy ||
                                  dirty ||
                                  !provider.enabled ||
                                  !model.enabled ||
                                  isDefault(provider.id, model.id)
                                }
                                onClick={() => void changeDefault(provider.id, model.id)}
                              >
                                {t("settings.modelSettings.setAsFallbackDefault")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                aria-label={t("settings.modelSettings.editModelValue", {
                                  value0: model.id,
                                })}
                                disabled={busy}
                                onClick={() => setModelDraft({ model, index })}
                              >
                                <Pencil size={14} />
                                {t("settings.modelSettings.editModel")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                aria-label={t("settings.modelSettings.moveModelValueUp", {
                                  value0: model.id,
                                })}
                                disabled={busy || index === 0}
                                onClick={() => {
                                  const models = [...provider.models];
                                  [models[index - 1], models[index]] = [
                                    models[index],
                                    models[index - 1],
                                  ];
                                  edit({ models });
                                }}
                              >
                                <ArrowUp size={14} />
                                {t("settings.modelSettings.moveUp")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                aria-label={t("settings.modelSettings.moveModelValueDown", {
                                  value0: model.id,
                                })}
                                disabled={busy || index === provider.models.length - 1}
                                onClick={() => {
                                  const models = [...provider.models];
                                  [models[index + 1], models[index]] = [
                                    models[index],
                                    models[index + 1],
                                  ];
                                  edit({ models });
                                }}
                              >
                                <ArrowDown size={14} />
                                {t("settings.modelSettings.moveDown")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                aria-label={t("settings.modelSettings.deleteModelValue", {
                                  value0: model.id,
                                })}
                                disabled={busy}
                                onClick={() =>
                                  edit({
                                    models: provider.models.filter(
                                      (_: Data, i: number) => i !== index,
                                    ),
                                  })
                                }
                              >
                                <Trash2 size={14} />
                                {t("settings.modelSettings.deleteModel")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ))}
                      {!visibleModels.length && (
                        <p className="settings-muted p-3">
                          {t("settings.modelSettings.noMatchingModels")}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="mt-1 flex h-12 items-center rounded-lg border border-dashed border-border px-4 text-ui-base text-foreground-subtle">
                      {t("settings.modelSettings.noModelsYetAddAModelOr")}
                    </div>
                  )}
                </div>
                <SettingsDisclosure title={<> {t("settings.modelSettings.advancedParameters")}</>}>
                  <div className="settings-field-pair mt-3">
                    <label>
                      {t("settings.modelSettings.maximumOutputTokens")}
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={provider.parameters.maxOutputTokens ?? ""}
                        onChange={(event) =>
                          edit({
                            parameters: {
                              ...provider.parameters,
                              maxOutputTokens:
                                event.target.value === "" ? null : Number(event.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                </SettingsDisclosure>
              </fieldset>
            ) : null}
            {current !== CHATGPT && provider && (
              <div className="provider-save-actions">
                <span role="status" className="settings-muted">
                  {dirty ? t("settings.modelSettings.unsavedChanges") : ""}
                </span>
                <Button
                  variant="outline"
                  disabled={busy || !dirty}
                  onClick={() =>
                    provider.id ? navigate(discard) : choose(items[0]?.id ?? CHATGPT)
                  }
                >
                  {t("settings.modelSettings.cancelChanges")}
                </Button>
                <Button
                  disabled={busy || !dirty}
                  onClick={() =>
                    void run(async () => {
                      await save();
                    })
                  }
                >
                  {busy ? t("settings.modelSettings.saving2") : t("settings.modelSettings.save")}
                </Button>
              </div>
            )}
          </div>
          {!picker && current !== CHATGPT && !provider && (
            <EmptySettings>
              {state.loading
                ? t("settings.modelSettings.loadingProviders")
                : t("settings.modelSettings.selectAProviderOnTheLeftOr")}
            </EmptySettings>
          )}
          <footer className="provider-default-link">
            <span>{t("settings.modelSettings.fallbackDefaultModel")}</span>
            <Button variant="link" disabled={busy} onClick={onOpenSessionSettings}>
              {t("settings.modelSettings.openSessionSettings")}
            </Button>
          </footer>
        </div>
      </div>
      {modelDraft && provider && (
        <ModelEditor
          model={modelDraft.model}
          editing={modelDraft.index >= 0}
          ids={provider.models
            .filter((_: Data, i: number) => i !== modelDraft.index)
            .map((m: Data) => m.id)}
          onClose={() => setModelDraft(null)}
          onSave={(model) => {
            const models = [...provider.models];
            if (modelDraft.index < 0) models.push(model);
            else models[modelDraft.index] = model;
            edit({ models });
            setModelDraft(null);
          }}
        />
      )}

      {remove && (
        <SettingsDialog
          className="settings-confirm-dialog"
          title={t("settings.modelSettings.removeProvider")}
          description={t("settings.modelSettings.afterRemovingValueTasksUsingThisProvider", {
            value0: remove.name,
          })}
          onClose={() => setRemove(null)}
          busy={busy}
        >
          <Feedback error={error} />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemove(null)}>
              {t("settings.modelSettings.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api({
                    operation: "removeAndApply",
                    id: remove.id,
                    expectedRevision: state.value?.revision,
                  });
                  setRemove(null);
                  select({
                    id:
                      items.find((item) => item.id !== remove.id)?.id ??
                      (accountEnabled ? CHATGPT : null),
                  });
                  await state.refresh();
                })
              }
            >
              {busy ? t("settings.modelSettings.removing") : t("settings.modelSettings.remove")}
            </Button>
          </DialogFooter>
        </SettingsDialog>
      )}
    </div>
  );
}
