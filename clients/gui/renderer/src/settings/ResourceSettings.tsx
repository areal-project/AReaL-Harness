import { TitleTooltip } from "@areal/ui";
import type { ResourceRequest, Scope } from "../services.js";
import { normalizeMcp } from "../services.js";
import {
  useI18n,
  UiMessageError,
  type UiMessage,
  type MessageId,
  formatUiMessage,
} from "../i18n/IntlProvider.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useSettingsOperation } from "./useSettingsOperation.js";
import { useDraftBlocker, useGuardedNavigation } from "./UnsavedChanges.js";
import { useEffect, useRef, useState } from "react";
import { BookOpen, Plug, Settings, Monitor } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { SettingsBadge } from "./SettingsPageParts.js";
import {
  EmptySettings,
  Feedback,
  SettingsDialog,
  SettingsToolbar,
  useResource,
  type SettingsProps,
} from "./common.js";
import { McpConfigEditor } from "./McpConfigEditor.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { ResourceScope, CatalogEmpty, type ScopedProps } from "./ScopedSkillsSettings.js";
import type { Data } from "../services.js";
import {
  pluginSourceLabel,
  pluginMcpStateLabel,
  type PluginMcpResource,
} from "./pluginResources.js";
const resourceMcpStateMessages: Record<string, MessageId> = {
  notApplied: "settings.resourceSettings.notApplied",
  connected: "settings.resourceSettings.connected",
  disconnected: "settings.resourceSettings.disconnected",
  failed: "settings.resourceSettings.connectionFailed",
  stale: "settings.resourceSettings.toolCatalogExpired",
  connecting: "settings.resourceSettings.connecting",
};
export function McpSettings({
  project,
  action,
  scope: controlledScope,
  onScopeChange,
  pluginServers = [],
  onManagePlugin,
  onRefreshPlugins,
  addRequest = 0,
}: ScopedProps & {
  addRequest?: number;
  pluginServers?: PluginMcpResource[];
  onManagePlugin?: (pluginId: string) => void;
  onRefreshPlugins?: () => Promise<void>;
}) {
  const { t, intl } = useI18n();
  const [localScope, setLocalScope] = useState("user");
  const scope = controlledScope ?? localScope;
  const setScope = (value: string) => {
    setLocalScope(value);
    onScopeChange?.(value);
  };
  const owner: Scope =
    scope === "user"
      ? { scope: "user", projectId: project?.id }
      : { scope: "project", projectId: project?.id };
  const api = <P extends ResourceRequest>(request: P) => action("resources", request);
  const state = useResource(() => api({ ...owner, operation: "mcp" }), `${scope}:${project?.id}`);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Data | null>(null);
  const [config, setConfig] = useState("");
  const navigate = useGuardedNavigation();
  const baseline = useRef({ id: "", config: "" });
  const operation = useSettingsOperation();
  const { busy, error, message, setError, setMessage } = operation;
  const disabled =
    busy ||
    state.loading ||
    (scope === "project" && (!project?.state?.connected || project?.pending?.length > 0));
  const run = (task: () => Promise<void>) =>
    operation.run(async () => {
      await task();
      await state.refresh();
    });
  const discard = () => {
    setDraft(null);
    setError("");
  };
  const save = async () => {
    if (!draft || disabled)
      throw new UiMessageError({ id: "settings.resourceSettings.cannotSaveRightNowTryAgainLater" });
    if (!draft.id.trim())
      throw new UiMessageError({ id: "settings.resourceSettings.serverIDCannotBeEmpty" });
    let parsed: Data;
    try {
      parsed = JSON.parse(config);
    } catch {
      throw new UiMessageError({
        id: "settings.resourceSettings.theMCPConfigurationIsNotValidJSON",
      });
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !parsed.transport)
      throw new UiMessageError({
        id: "settings.resourceSettings.provideAnMCPConfigurationContainingTransport",
      });
    const transport = parsed.transport;
    if (transport.type === "stdio" && !transport.command?.trim())
      throw new UiMessageError({ id: "settings.resourceSettings.commandCannotBeEmpty" });
    if (transport.type === "streamableHttp") {
      try {
        if (!["http:", "https:"].includes(new URL(transport.url).protocol)) throw new Error();
      } catch {
        throw new UiMessageError({ id: "settings.resourceSettings.theServerURLMustBeAValid" });
      }
    }
    const result = await api({
      ...owner,
      operation: "mcpSave",
      id: draft.id.trim(),
      expectedRevision: scope === "user" ? state.value?.revision : draft.revision,
      config: normalizeMcp(parsed),
    });
    setDraft(null);
    await state.refresh();
    setMessage(
      ("warning" in result && result.warning) || {
        id: "settings.resourceSettings.configurationSaved",
      },
    );
  };
  useDraftBlocker({
    label: { id: "settings.resourceSettings.mcpConfiguration" },
    dirty: !!draft && (draft.id !== baseline.current.id || config !== baseline.current.config),
    busy,
    discard,
    save: () => operation.execute(save),
  });
  const edit = (
    item: Data = {
      id: "",
      revision: 0,
      config: { transport: { type: "stdio", command: "", args: [] } },
    },
  ) => {
    baseline.current = { id: item.id, config: JSON.stringify(item.config, null, 2) };
    setDraft(item);
    setConfig(baseline.current.config);
    setError("");
  };
  useEffect(() => {
    if (addRequest) edit();
  }, [addRequest]);
  const source = t("settings.resourceSettings.standaloneResourcesValue", {
    value0:
      scope === "user"
        ? t("settings.resourceSettings.user")
        : t("settings.resourceSettings.currentProject"),
  });
  const packageItems = pluginServers.filter((item) =>
    `${item.serverId} ${pluginSourceLabel(item.owner, t)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const items = (state.loading ? [] : (state.value?.data ?? [])).filter((item: Data) =>
    [
      item.id,
      source,
      item.config?.transport?.command,
      item.config?.transport?.url,
      ...(item.tools ?? []).map((tool: Data) => tool.name),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="resource-settings">
      {!draft && (
        <>
          <div className="resource-catalog-bar">
            <ResourceScope
              value={scope}
              onChange={(v) => {
                setScope(v);
                setQuery("");
                setError("");
                setMessage("");
              }}
              project={project}
              disabled={busy}
            />
            <strong>
              MCP{" "}
              <small>
                {intl.formatNumber((state.value?.data?.length ?? 0) + pluginServers.length)}
              </small>
            </strong>
            <SettingsSearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
              clearLabel={t("settings.resourceSettings.clearSearch")}
              placeholder={t("settings.resourceSettings.searchMCPServers")}
              aria-label={t("settings.resourceSettings.searchMCPServers2")}
            />
          </div>
          <SettingsToolbar
            description={
              scope === "user"
                ? t("settings.resourceSettings.reusableAcrossAllProjectsTheConnectionToggle")
                : t("settings.resourceSettings.onlyForTheCurrentProject")
            }
            loading={state.loading}
            disabled={disabled}
            onRefresh={() => {
              void state.refresh();
              void onRefreshPlugins?.();
            }}
            onAdd={() => edit()}
            addLabel={t("settings.resourceSettings.addMCP")}
          />
          <Feedback error={state.error || (!draft ? error : "")} message={message} />
          <div className="settings-resource-list">
            {items.map((item: Data) => (
              <article key={`standalone:${scope}:${item.id}`} aria-label={`${item.id} · ${source}`}>
                <div className="resource-title">
                  <Plug size={20} />
                  <div>
                    <strong>{item.id}</strong>
                    <p>{source}</p>
                    {/* MCP 启动命令／URL 单行截断，长命令看不到后半段；补完整值的原生 title。 */}
                    <TitleTooltip
                      title={`${item.config.transport?.type ?? ""} ${
                        item.config.transport?.command ?? item.config.transport?.url ?? ""
                      }`.trim()}
                    >
                      <p>
                        {item.config.transport?.type} ·{" "}
                        {item.config.transport?.command ?? item.config.transport?.url ?? ""}
                      </p>
                    </TitleTooltip>
                  </div>
                  <SettingsBadge>
                    {resourceMcpStateMessages[item.state]
                      ? t(resourceMcpStateMessages[item.state])
                      : item.state}
                  </SettingsBadge>
                  <Button
                    variant="ghost"
                    aria-label={t("settings.resourceSettings.editMCPValue", { value0: item.id })}
                    disabled={
                      disabled || !["disconnected", "failed", "notApplied"].includes(item.state)
                    }
                    onClick={() => edit(item)}
                  >
                    <Settings />
                  </Button>
                  <Switch
                    checked={!["disconnected", "failed", "notApplied"].includes(item.state)}
                    disabled={disabled || !project || item.state === "connecting"}
                    aria-label={
                      ["disconnected", "failed", "notApplied"].includes(item.state)
                        ? t("settings.resourceSettings.connectValue", { value0: item.id })
                        : t("settings.resourceSettings.disconnectValue", { value0: item.id })
                    }
                    onCheckedChange={() =>
                      void run(async () => {
                        const connecting = ["disconnected", "failed", "notApplied"].includes(
                          item.state,
                        );
                        await api({
                          ...owner,
                          operation: connecting ? "mcpConnect" : "mcpDisconnect",
                          projectId: project?.id,
                          id: item.id,
                          expectedRevision: item.revision,
                        });
                        setMessage({
                          id: "settings.resourceSettings.connectionStatusRefreshedForValue",
                          values: { value0: item.id },
                        });
                      })
                    }
                  />
                </div>
                {item.error && <Feedback error={item.error} />}
                <SettingsDisclosure
                  className="mt-3"
                  title={
                    <>
                      {" "}
                      {t("settings.resourceSettings.toolCount", {
                        count: item.tools?.length ?? 0,
                      })}{" "}
                    </>
                  }
                >
                  {item.tools?.length ? (
                    item.tools.map((tool: Data) => (
                      <div className="settings-tool" key={tool.name}>
                        <strong>{tool.name}</strong>
                        <p>{tool.description}</p>
                      </div>
                    ))
                  ) : (
                    <p className="settings-muted">
                      {t("settings.resourceSettings.noToolsAvailableYetConnectAndRefresh")}
                    </p>
                  )}
                </SettingsDisclosure>
              </article>
            ))}
            {packageItems.map((item) => (
              <article
                key={item.key}
                aria-label={`${item.serverId} · ${pluginSourceLabel(item.owner, t)}`}
              >
                <div className="resource-title">
                  <Plug size={20} />
                  <div>
                    <strong>{item.serverId}</strong>
                    <p>{pluginSourceLabel(item.owner, t)}</p>
                    <p>
                      {item.owner.compatibilityBlocked
                        ? t("operations.componentIncompatible")
                        : item.owner.enabled
                          ? t("settings.resourceSettings.enabledInCurrentProject")
                          : t("settings.resourceSettings.disabledInCurrentProject")}
                    </p>
                  </div>
                  <SettingsBadge>{pluginMcpStateLabel(item.state, t)}</SettingsBadge>
                  <Button variant="outline" onClick={() => onManagePlugin?.(item.owner.pluginId)}>
                    {t("settings.resourceSettings.managePlugin")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!state.loading && !items.length && !packageItems.length && (
            <CatalogEmpty kind="mcp" query={query} scope={scope} onAdd={() => edit()} />
          )}
        </>
      )}
      {draft && (
        <section className="resource-editor">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => navigate(discard)}>
            {t("settings.resourceSettings.backToMCPServers")}
          </Button>
          <h2>
            {draft.revision || draft.runtimeId
              ? t("settings.resourceSettings.editMCPServer")
              : t("settings.resourceSettings.addMCPServer")}
          </h2>
          <p className="settings-muted">
            {t("settings.resourceSettings.configureALocalCommandOrHTTPService")}
          </p>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void operation.run(save);
            }}
          >
            <fieldset disabled={disabled}>
              <label>
                {t("settings.resourceSettings.serverID")}
                <Input
                  required
                  value={draft.id}
                  disabled={!!draft.revision || !!draft.runtimeId}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </label>
              <McpConfigEditor value={config} onChange={setConfig} />
            </fieldset>
            <Feedback error={error} />
            <div className="settings-form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => navigate(discard)}
              >
                {t("settings.resourceSettings.cancel")}
              </Button>
              <Button type="submit" disabled={disabled}>
                {busy
                  ? t("settings.resourceSettings.saving")
                  : t("settings.resourceSettings.saveMCPConfiguration")}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
function SkillContent({
  project,
  thread,
  action,
  skill,
  resource,
  onResource,
}: SettingsProps & {
  skill: Data;
  resource: string;
  onResource: (path: string) => void;
}) {
  const { t, intl } = useI18n();
  const read = (offset: number) =>
    action("manage", {
      projectId: project.id,
      threadId: thread!.id,
      operation: "skill",
      skill: { id: skill.id, revision: skill.revision },
      resource,
      offset,
      maxBytes: 8192,
    });
  const state = useResource(() => read(0), `${skill.id}:${skill.revision}:${resource}`);
  const [extra, setExtra] = useState<Data[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiMessage | string>("");
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const chunks = state.value ? [state.value, ...extra] : [];
  const last = chunks.at(-1);
  const bytes = chunks.flatMap((chunk) =>
    Array.from(atob(chunk.dataBase64 ?? ""), (char) => char.charCodeAt(0)),
  );
  return (
    <>
      <Feedback
        error={
          state.error || error
            ? t("settings.resourceSettings.couldNotReadValueValue", {
                value0: resource,
                value1: formatUiMessage(t, state.error || error),
              })
            : undefined
        }
        message={state.loading ? t("settings.resourceSettings.loadingResource") : undefined}
      />
      {state.value && (
        <>
          <p className="settings-muted">
            {resource} · {last?.sizeBytes == null ? "" : intl.formatNumber(last.sizeBytes)}{" "}
            {t("settings.resourceSettings.bytes")}
          </p>
          <SettingsSegmentedTabs
            items={[
              { value: "preview", label: t("settings.resourceSettings.preview") },
              { value: "source", label: t("settings.resourceSettings.source") },
            ]}
            value={mode}
            onValueChange={setMode}
          />
          {mode === "preview" && /\.md$/i.test(resource) ? (
            <div className="skill-content">
              <MessageResponse
                fileLinks
                onOpenFileLink={(path) => {
                  const resolved = new URL(
                    path,
                    `https://skill.invalid/${resource}`,
                  ).pathname.slice(1);
                  onResource(decodeURIComponent(resolved));
                }}
              >
                {new TextDecoder()
                  .decode(new Uint8Array(bytes))
                  .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}
              </MessageResponse>
            </div>
          ) : (
            <pre className="skill-content">{new TextDecoder().decode(new Uint8Array(bytes))}</pre>
          )}
          {!last?.eof && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await read(last!.nextOffset);
                  setExtra((previous) => [...previous, result]);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("settings.resourceSettings.readMore")}
            </Button>
          )}
        </>
      )}
    </>
  );
}
export function TaskSkillsSettings(props: SettingsProps) {
  const { t, intl } = useI18n();
  const { project, thread, action } = props;
  const state = useResource(
    () =>
      thread
        ? action("manage", {
            projectId: project.id,
            threadId: thread.id,
            operation: "skills",
          })
        : Promise.resolve({ data: [] }),
    `${project.id}:${thread?.id}`,
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Data | null>(null);
  const [resource, setResource] = useState("SKILL.md");
  const [resourcePath, setResourcePath] = useState("SKILL.md");
  const items = (state.value?.data ?? []).filter((item: Data) =>
    [item.id, item.name, item.description].join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="resource-settings">
      <div className="resource-catalog-bar">
        <span className="resource-scope">
          <Monitor size={16} /> {t("settings.resourceSettings.currentTask")}
        </span>
        <strong>
          {t("settings.resourceSettings.skills")}
          <small>{intl.formatNumber(state.value?.data?.length ?? 0)}</small>
        </strong>
        <SettingsSearchInput
          placeholder={t("settings.resourceSettings.searchSkills")}
          aria-label={t("settings.resourceSettings.searchSkills2")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel={t("settings.resourceSettings.clearSearch")}
        />
      </div>
      <SettingsToolbar
        description={t("settings.resourceSettings.thisTaskHasValueBoundSkillsSelect", {
          value0: state.value?.data?.length ?? 0,
        })}
        loading={state.loading}
        onRefresh={() => void state.refresh()}
      />
      <Feedback error={state.error} />
      <div className="settings-resource-list">
        {items.map((item: Data) => (
          <article className="skill-resource-row" key={`${item.id}:${item.revision}`}>
            <Button
              unstyled
              data-slot={undefined}
              type="submit"
              className="resource-card"
              disabled={!item.available}
              aria-label={item.id}
              onClick={() => {
                setSelected(item);
                setResource("SKILL.md");
                setResourcePath("SKILL.md");
              }}
            >
              <BookOpen size={20} />
              <span>
                <strong>{item.name || item.id}</strong>
                <TitleTooltip title={item.description}>
                  <small>
                    {item.description ||
                      t("settings.resourceSettings.versionValueViewSkillContent", {
                        value0: item.revision,
                      })}
                  </small>
                </TitleTooltip>
              </span>
              <SettingsBadge>
                {!item.available
                  ? t("settings.resourceSettings.unavailable")
                  : state.value?.loaded?.[item.id]
                    ? t("settings.resourceSettings.read")
                    : t("settings.resourceSettings.available")}
              </SettingsBadge>
            </Button>
          </article>
        ))}
      </div>
      {!state.loading && !items.length && (
        <EmptySettings>
          {!thread
            ? t("settings.resourceSettings.selectATaskToViewSkillsWithin")
            : query
              ? t("settings.resourceSettings.noMatchingSkills")
              : t("settings.resourceSettings.noSkillsAreAvailableForTheCurrent")}
        </EmptySettings>
      )}

      {selected && thread && (
        <SettingsDialog
          title={selected.name || selected.id}
          description={
            selected.description ||
            t("settings.resourceSettings.versionValueSkillResourcesForTheCurrent", {
              value0: selected.revision,
            })
          }
          onClose={() => {
            setSelected(null);
            void state.refresh();
          }}
        >
          <form
            className="skill-resource-path"
            onSubmit={(e) => {
              e.preventDefault();
              setResource(resourcePath.trim() || "SKILL.md");
            }}
          >
            <label>
              {t("settings.resourceSettings.skillResources")}
              <Input
                aria-label={t("settings.resourceSettings.skillResources")}
                value={resourcePath}
                onChange={(e) => setResourcePath(e.target.value)}
                placeholder={t("settings.resourceSettings.skillMdOrReferencesGuideMd")}
              />
            </label>
            <Button type="submit" variant="outline">
              {t("settings.resourceSettings.readResource")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setResource("SKILL.md");
                setResourcePath("SKILL.md");
              }}
            >
              {t("settings.resourceSettings.backToSKILLMd")}
            </Button>
          </form>
          <SkillContent
            key={`${selected.id}:${selected.revision}:${resource}`}
            {...props}
            skill={selected}
            resource={resource}
            onResource={(path) => {
              setResource(path);
              setResourcePath(path);
            }}
          />
        </SettingsDialog>
      )}
    </div>
  );
}
export { SessionSettings } from "./SessionSettings.js";
export { ScopedSkillsSettings as SkillsSettings } from "./ScopedSkillsSettings.js";
