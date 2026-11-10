import { TitleTooltip } from "@areal/ui";
import type { ManagementRequest } from "../services.js";
import {
  useI18n,
  UiMessageError,
  type UiMessage,
  type MessageId,
  formatUiMessage,
} from "../i18n/IntlProvider.js";
import { useSettingsOperation } from "./useSettingsOperation.js";
import { useDraftBlocker, useGuardedNavigation } from "./UnsavedChanges.js";
import { useEffect, useRef, useState } from "react";
import { BookOpen, Plug, Settings, Monitor, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
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
import { CatalogEmpty, type ScopedProps } from "./ScopedSkillsSettings.js";
import type { Data } from "../services.js";
import {
  pluginSourceLabel,
  pluginMcpStateLabel,
  type PluginMcpResource,
} from "./pluginResources.js";
const LOCAL_MCP = "@local-mcp";
type LocalMcp = { name: string; id: string; server: Data };
function mcpTarget(server: Data) {
  return typeof server.url === "string"
    ? `http · ${server.url}`
    : `stdio · ${[server.command, ...(server.args ?? [])].join(" ")}`;
}
/** 直接添加的 MCP 是只含一个服务的本地插件：这里只编辑声明，启用与连接在插件页管理。 */
export function McpSettings({
  project,
  action,
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
  const api = <P extends ManagementRequest>(request: P) => action("manage", request);
  const state = useResource(
    () => api({ operation: "mcp", ...(project?.id ? { projectId: project.id } : {}) }),
    `${project?.id}`,
  );
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{ name: string; existing: boolean } | null>(null);
  const [config, setConfig] = useState("");
  const navigate = useGuardedNavigation();
  const baseline = useRef({ name: "", config: "" });
  const operation = useSettingsOperation();
  const { busy, error, message, setError, setMessage } = operation;
  const disabled = busy || state.loading;
  const refresh = async () => {
    await state.refresh();
    await onRefreshPlugins?.();
  };
  const discard = () => {
    setDraft(null);
    setError("");
  };
  const save = async () => {
    if (!draft || disabled)
      throw new UiMessageError({ id: "settings.resourceSettings.cannotSaveRightNowTryAgainLater" });
    const name = draft.name.trim();
    if (!name) throw new UiMessageError({ id: "settings.resourceSettings.serverIDCannotBeEmpty" });
    let server: Data;
    try {
      server = JSON.parse(config);
    } catch {
      throw new UiMessageError({
        id: "settings.resourceSettings.theMCPConfigurationIsNotValidJSON",
      });
    }
    if (!server || Array.isArray(server) || typeof server !== "object")
      throw new UiMessageError({ id: "settings.resourceSettings.theMCPConfigurationIsNotValidJSON" });
    if (typeof server.url !== "string" && !String(server.command ?? "").trim())
      throw new UiMessageError({ id: "settings.resourceSettings.commandCannotBeEmpty" });
    if (typeof server.url === "string") {
      try {
        if (!["http:", "https:"].includes(new URL(server.url).protocol)) throw new Error();
      } catch {
        throw new UiMessageError({ id: "settings.resourceSettings.theServerURLMustBeAValid" });
      }
    }
    await api({
      operation: "mcpSave",
      name,
      server,
      expectedRevision: state.value?.revision ?? 0,
    });
    setDraft(null);
    await refresh();
    setMessage({ id: "settings.resourceSettings.configurationSaved" });
  };
  useDraftBlocker({
    label: { id: "settings.resourceSettings.mcpConfiguration" },
    dirty: !!draft && (draft.name !== baseline.current.name || config !== baseline.current.config),
    busy,
    discard,
    save: () => operation.execute(save),
  });
  const edit = (item?: { name: string; server: Data }) => {
    const text = JSON.stringify(item?.server ?? { command: "", args: [] }, null, 2);
    baseline.current = { name: item?.name ?? "", config: text };
    setDraft({ name: item?.name ?? "", existing: !!item });
    setConfig(text);
    setError("");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 外部“新增”入口以计数请求打开编辑器
  useEffect(() => {
    if (addRequest) edit();
  }, [addRequest]);
  const remove = (name: string) =>
    operation.run(async () => {
      await api({ operation: "mcpRemove", name, expectedRevision: state.value?.revision ?? 0 });
      await refresh();
      setMessage({ id: "settings.resourceSettings.mcpRemoved", values: { value0: name } });
    });
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const local = (state.loading ? [] : (state.value?.data ?? [])).filter((item: LocalMcp) =>
    matches(`${item.name} ${mcpTarget(item.server)}`),
  );
  const packageItems = pluginServers.filter(
    (item) =>
      !item.owner.pluginId.endsWith(LOCAL_MCP) &&
      matches(`${item.serverId} ${pluginSourceLabel(item.owner, t)}`),
  );
  const localState = (id: string) =>
    pluginServers.find((item) => item.owner.pluginId === id);
  return (
    <div className="resource-settings">
      {!draft && (
        <>
          <div className="resource-catalog-bar">
            <strong>
              MCP{" "}
              <small>
                {intl.formatNumber(
                  (state.value?.data?.length ?? 0) +
                    pluginServers.filter((item) => !item.owner.pluginId.endsWith(LOCAL_MCP)).length,
                )}
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
            description={t("settings.resourceSettings.directMcpIsAPlugin")}
            loading={state.loading}
            disabled={disabled}
            onRefresh={() => void refresh()}
            onAdd={() => edit()}
            addLabel={t("settings.resourceSettings.addMCP")}
          />
          <Feedback error={state.error || error} message={message} />
          <div className="settings-resource-list">
            {local.map((item: LocalMcp) => {
              const live = localState(item.id);
              return (
                <article key={item.id} aria-label={item.name}>
                  <div className="resource-title">
                    <Plug size={20} />
                    <div>
                      <strong>{item.name}</strong>
                      <p>{t("settings.resourceSettings.addedDirectly")}</p>
                      {/* 启动命令／URL 单行截断，补完整值的原生 title。 */}
                      <TitleTooltip title={mcpTarget(item.server)}>
                        <p>{mcpTarget(item.server)}</p>
                      </TitleTooltip>
                    </div>
                    {live && <SettingsBadge>{pluginMcpStateLabel(live.state, t)}</SettingsBadge>}
                    <Button
                      variant="ghost"
                      aria-label={t("settings.resourceSettings.editMCPValue", { value0: item.name })}
                      disabled={disabled}
                      onClick={() => edit(item)}
                    >
                      <Settings />
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={t("settings.resourceSettings.removeMCPValue", {
                        value0: item.name,
                      })}
                      disabled={disabled}
                      onClick={() => void remove(item.name)}
                    >
                      <Trash2 />
                    </Button>
                    <Button variant="outline" onClick={() => onManagePlugin?.(item.id)}>
                      {t("settings.resourceSettings.managePlugin")}
                    </Button>
                  </div>
                </article>
              );
            })}
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
          {!state.loading && !local.length && !packageItems.length && (
            <CatalogEmpty kind="mcp" query={query} scope="user" onAdd={() => edit()} />
          )}
        </>
      )}
      {draft && (
        <section className="resource-editor">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => navigate(discard)}>
            {t("settings.resourceSettings.backToMCPServers")}
          </Button>
          <h2>
            {draft.existing
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
                  value={draft.name}
                  disabled={draft.existing}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
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
