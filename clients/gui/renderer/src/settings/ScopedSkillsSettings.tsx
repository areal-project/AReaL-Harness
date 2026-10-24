import { ResourceScope as ScopeView, CatalogEmpty as EmptyView } from "@areal/ui/wip";
import { useI18n, type UiMessage } from "../i18n/IntlProvider.js";
import { useState } from "react";
import { BookOpen, Plug, ChevronDown, Folder, Monitor } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../components/ui/dropdown-menu.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { SettingsBadge } from "./SettingsPageParts.js";
import {
  Feedback,
  SettingsDialog,
  SettingsToolbar,
  useResource,
} from "./common.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import type { Action, Data } from "../services.js";
import { pluginSourceLabel, type PluginSkillResource } from "./pluginResources.js";
export type ScopedProps = {
  project?: Data;
  thread?: Data;
  action: Action;
  scope?: string;
  onScopeChange?: (scope: string) => void;
};
export function ResourceScope({ value, onChange, project, task = false, disabled = false }: { value: string; onChange: (value: string) => void; project?: Data; task?: boolean; disabled?: boolean }) {
 const { t } = useI18n(); return <ScopeView value={value} onChange={onChange} hasProject={!!project} task={task} disabled={disabled} labels={{ scope: t("settings.scopedSkillsSettings.resourceScope"), user: t("settings.scopedSkillsSettings.user"), project: t("settings.scopedSkillsSettings.currentProject"), task: t("settings.scopedSkillsSettings.currentTask") }} />;
}
export function CatalogEmpty({ kind, query, scope, onAdd }: { kind: "mcp" | "skill"; query: string; scope: string; onAdd?: () => void }) {
 const { t } = useI18n(); return <EmptyView kind={kind} title={query ? t("settings.scopedSkillsSettings.noMatchingResources", { kind }) : t("settings.scopedSkillsSettings.noResourcesYet", { scope, kind })} description={query ? t("settings.scopedSkillsSettings.tryAnotherNameOrKeyword") : scope === "user" ? t("settings.scopedSkillsSettings.sharedResources", { kind }) : t("settings.scopedSkillsSettings.projectResources", { kind })} addLabel={t("settings.scopedSkillsSettings.addResource", { kind })} onAdd={query ? undefined : onAdd} />;
}

export function ScopedSkillsSettings({
  project,
  action,
  scope: controlledScope,
  onScopeChange,
  pluginSkills = [],
  onManagePlugin,
  onRefreshPlugins,
}: ScopedProps & {
  pluginSkills?: PluginSkillResource[];
  onManagePlugin?: (pluginId: string) => void;
  onRefreshPlugins?: () => Promise<void>;
}) {
  const { t, intl } = useI18n();
  const [localScope, setLocalScope] = useState("user"),
    [query, setQuery] = useState(""),
    [draft, setDraft] = useState<Data | null>(null),
    [selected, setSelected] = useState<Data | null>(null),
    [content, setContent] = useState(""),
    [contentTruncated, setContentTruncated] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<UiMessage | string>(""),
    [message, setMessage] = useState<UiMessage | string>("");
  const scope = controlledScope ?? localScope;
  const setScope = (value: string) => {
    setLocalScope(value);
    onScopeChange?.(value);
  };
  const api = (operation: string, values: Data = {}) =>
    action("resources", {
      operation,
      scope,
      projectId: project?.id,
      ...values,
    });
  const state = useResource(() => api("skills"), `${scope}:${project?.id}`);
  const source = t("settings.scopedSkillsSettings.standaloneResourcesValue", { value0: scope === "user" ? t("settings.scopedSkillsSettings.user") : t("settings.scopedSkillsSettings.currentProject") });
  const packageItems = pluginSkills.filter((item) =>
    `${item.name} ${item.id} ${item.description} ${pluginSourceLabel(item.owner, t)}`
      .toLowerCase().includes(query.toLowerCase()),
  );
  const items = (state.value?.data ?? []).filter((s: Data) =>
    `${s.name} ${s.id} ${s.description} ${source}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await state.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    setError("");
    setDraft({ id: "", name: "", description: "", content: "" });
  };
  return (
    <div className="resource-settings scoped-catalog">
      <div className="resource-catalog-bar">
        <ResourceScope
          value={scope}
          project={project}
          disabled={busy}
          onChange={(v) => {
            setScope(v);
            setQuery("");
            setError("");
            setMessage("");
          }}
        />
        <strong>
          {t("settings.scopedSkillsSettings.skills")}{" "}
          <small>
            {state.loading ? "…" : intl.formatNumber((state.value?.data?.length ?? 0) + pluginSkills.length)}
          </small>
        </strong>
        <SettingsSearchInput
          aria-label={t("settings.scopedSkillsSettings.searchSkills")}
          placeholder={t("settings.scopedSkillsSettings.searchSkills2")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel={t("settings.scopedSkillsSettings.clearSearch")}
        />
      </div>
      <SettingsToolbar
        description={
          scope === "user"
            ? t("settings.scopedSkillsSettings.availableToAllProjectsProjectConfigurationTakes")
            : t("settings.scopedSkillsSettings.onlyForTheCurrentProjectChangesTake")
        }
        loading={state.loading}
        disabled={busy || state.loading}
        onRefresh={() => { void state.refresh(); void onRefreshPlugins?.(); }}
        onAdd={add}
        addLabel={t("settings.scopedSkillsSettings.createSkill")}
      />
      <Feedback error={state.error || error} message={message} />
      {state.value?.customDeployment && (
        <Feedback message={t("settings.scopedSkillsSettings.aCustomDeploymentIsInUseTask")} />
      )}
      <div className="settings-resource-list">
        {!state.loading &&
          items.map((item: Data) => (
            <article className="skill-resource-row" key={`standalone:${scope}:${item.id}`} aria-label={`${item.name || item.id} · ${source}`}>
              <button
                className="resource-card"
                aria-label={t("settings.scopedSkillsSettings.viewSkillValue", { value0: item.id })}
                disabled={busy || !!item.error}
                onClick={() =>
                  void run(async () => {
                    const result = await api("skillRead", { id: item.id });
                    setContent(result.content);
                    setContentTruncated(!!result.truncated);
                    setSelected(item);
                  })
                }
              >
                <BookOpen size={20} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{source}</small>
                  <small title={item.description || item.error}>
                    {item.error || item.description || t("settings.scopedSkillsSettings.viewSkillContent")}
                  </small>
                </span>
              </button>
              {item.overridden && <SettingsBadge>{t("settings.scopedSkillsSettings.overriddenByProject")}</SettingsBadge>}
              <Switch
                aria-label={t("settings.scopedSkillsSettings.valueSkillValue", { value0: item.enabled ? t("settings.scopedSkillsSettings.disable") : t("settings.scopedSkillsSettings.enable"), value1: item.id })}
                checked={!!item.enabled}
                disabled={busy || !!item.error}
                onCheckedChange={() =>
                  void run(async () => {
                    await api("skillToggle", {
                      id: item.id,
                      enabled: !item.enabled,
                      expectedRevision: state.value?.revision,
                    });
                    setMessage({ id: "settings.scopedSkillsSettings.savedChangesTakeEffectInNewTasks" });
                  })
                }
              />
            </article>
          ))}
        {packageItems.map((item) => (
          <article className="skill-resource-row" key={item.key} aria-label={`${item.name} · ${pluginSourceLabel(item.owner, t)}`}>
            <div className="resource-card">
              <BookOpen size={20} />
              <span>
                <strong>{item.name}</strong>
                <small>{pluginSourceLabel(item.owner, t)}</small>
                <small title={item.description}>{item.description || item.id}</small>
              </span>
            </div>
            <SettingsBadge>{item.owner.compatibilityBlocked ? t("operations.componentIncompatible") : item.owner.enabled ? t("settings.scopedSkillsSettings.enabledInCurrentProject") : t("settings.scopedSkillsSettings.disabledInCurrentProject")}</SettingsBadge>
            <Button variant="outline" onClick={() => onManagePlugin?.(item.owner.pluginId)}>{t("settings.scopedSkillsSettings.managePlugin")}</Button>
          </article>
        ))}
      </div>
      {!state.loading && !items.length && !packageItems.length && !state.error && (
        <CatalogEmpty kind="skill" scope={scope} query={query} onAdd={add} />
      )}
      {selected && (
        <SettingsDialog
          title={selected.name}
          description={selected.description || t("settings.scopedSkillsSettings.skillContentPreview")}
          onClose={() => setSelected(null)}
        >
          <div className="skill-preview">
            <MessageResponse>{content}</MessageResponse>
            {contentTruncated && <p>{t("settings.scopedSkillsSettings.truncatedContent")}</p>}
          </div>
        </SettingsDialog>
      )}
      {draft && (
        <SettingsDialog
          title={t("settings.scopedSkillsSettings.createSkill")}
          description={
            scope === "user"
              ? t("settings.scopedSkillsSettings.saveAsAUserSkillAvailableTo")
              : t("settings.scopedSkillsSettings.saveAsAProjectSkillForThe")
          }
          busy={busy}
          onClose={() => setDraft(null)}
        >
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("skillSave", {
                  ...draft,
                  expectedRevision: state.value?.revision,
                });
                setDraft(null);
                setMessage({ id: "settings.scopedSkillsSettings.skillSavedChangesTakeEffectInNew" });
              });
            }}
          >
            <fieldset disabled={busy}>
              <div className="resource-form-grid">
                <label>
                  {t("settings.scopedSkillsSettings.skillID")}<Input
                    required
                    value={draft.id}
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  />
                </label>
                <label>
                  {t("settings.scopedSkillsSettings.displayName")}<Input
                    required
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </label>
              </div>
              <label>
                {t("settings.scopedSkillsSettings.description")}<Input
                  required
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                />
              </label>
              <label>
                {t("settings.scopedSkillsSettings.skillInstructions")}<textarea
                  required
                  rows={8}
                  value={draft.content}
                  onChange={(e) =>
                    setDraft({ ...draft, content: e.target.value })
                  }
                />
              </label>
            </fieldset>
            <Feedback error={error} />
            <div className="settings-form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                {t("settings.scopedSkillsSettings.cancel")}</Button>
              <Button type="submit" disabled={busy}>
                {busy ? t("settings.scopedSkillsSettings.saving") : t("settings.scopedSkillsSettings.saveSkill")}
              </Button>
            </div>
          </form>
        </SettingsDialog>
      )}
    </div>
  );
}
