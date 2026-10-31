import { useI18n, UiMessageError, type UiMessage, formatUiMessage } from "../i18n/IntlProvider.js";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BookOpen, Check, MoreHorizontal } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Switch } from "../components/ui/switch.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { Feedback } from "./common.js";
import type { ComposerSkill } from "../ComposerSkills.js";
import type { Action, Data } from "../services.js";

export type ResourceDraftSeed =
  | { kind: "creator"; projectId: string }
  | {
      kind?: "resource";
      text: string;
      skill?: ComposerSkill;
      plugin?: { id: string };
      profile?: { id: string; revision: string };
    };
export type CenterSkill = {
  key: string;
  id: string;
  revision?: string;
  name: string;
  description?: string;
  enabled: boolean;
  scope: "user" | "project" | "plugin";
  sourceLabel: string | UiMessage;
  projectId?: string;
  pluginId?: string;
  catalogRevision?: number;
  error?: string;
};

function skillOwner(
  skill: CenterSkill,
): import("@areal/workbench/desktop-contract/resource").Scope {
  if (skill.scope === "user") return { scope: "user" };
  if (skill.scope === "project" && skill.projectId)
    return { scope: "project", projectId: skill.projectId };
  throw new UiMessageError({ id: "settings.pluginSkillsPage.connectTheOwningProjectToReadThe" });
}

async function skillBody(action: Action, skill: CenterSkill, project?: Data) {
  if (skill.revision === undefined) throw new Error(skill.error);
  if (skill.scope !== "plugin") {
    const result = await action("resources", {
      ...skillOwner(skill),
      operation: "skillRead",
      id: skill.id,
    });
    if (result.truncated)
      throw new UiMessageError({
        id: "settings.pluginSkillsPage.theSkillContentExceedsTheReadableLimit",
      });
    return String(result.content);
  }
  if (!project?.state?.connected)
    throw new UiMessageError({ id: "settings.pluginSkillsPage.connectTheOwningProjectToReadThe" });
  const profile =
    project.profiles.find((item: Data) => item.id === "areal-standard") ?? project.profiles[0];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const page = await action("manage", {
      operation: "skill",
      projectId: project.id,
      agentProfile: { id: profile?.id, revision: profile?.revision },
      skill: { id: skill.id, revision: skill.revision },
      resource: "SKILL.md",
      offset,
      maxBytes: 8192,
    });
    if (page.sizeBytes > 256 * 1024)
      throw new UiMessageError({
        id: "settings.pluginSkillsPage.theSkillContentExceedsTheReadableLimit",
      });
    chunks.push(Uint8Array.from(atob(page.dataBase64), (char) => char.charCodeAt(0)));
    if (page.eof) break;
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
      throw new UiMessageError({ id: "settings.pluginSkillsPage.theSkillPageIsInvalid" });
    offset = page.nextOffset;
  }
  const body = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) {
    body.set(chunk, position);
    position += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export function PluginSkillsPage({
  action,
  projects,
  project,
  packageSkills,
  selected,
  onOpen,
  onManagePlugin,
  onStartDraft,
  compact,
  onCreate,
  createBusy,
  active,
}: {
  action: Action;
  projects: Data[];
  project?: Data;
  packageSkills: CenterSkill[];
  selected: CenterSkill | null;
  onOpen: (skill: CenterSkill) => void;
  onManagePlugin: (id: string) => void;
  onStartDraft: (seed: ResourceDraftSeed) => Promise<void>;
  compact: boolean;
  onCreate: () => void;
  createBusy: boolean;
  active: boolean;
}) {
  const { t, intl } = useI18n();
  const sourceLabel = (skill: CenterSkill) => formatUiMessage(t, skill.sourceLabel);
  const [loadFailures, setLoadFailures] = useState<{ source: string | UiMessage; error: string }[]>(
    [],
  );
  const [items, setItems] = useState<CenterSkill[]>([]);
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState("user");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const listId = useId();
  const [error, setError] = useState<UiMessage | string>("");
  const [message, setMessage] = useState<UiMessage | string>("");
  const [busy, setBusy] = useState(false);
  const [content, setContent] = useState("");
  const [contentLoading, setContentLoading] = useState(false);
  const generation = useRef(0);
  const draftGeneration = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    draftGeneration.current++;
    return () => {
      draftGeneration.current++;
    };
  }, [active, project?.id, selected?.key, selected?.revision]);
  const projectKey = projects
    .filter((item) => !item.projectless)
    .map((item) => `${item.id}:${item.root}`)
    .join("|");
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    const owners = [
      {
        scope: "user" as const,
        projectId: undefined,
        label: { id: "settings.pluginSkillsPage.personal" } as UiMessage,
      },
      ...projects
        .filter((item) => !item.projectless)
        .map((item) => ({
          scope: "project" as const,
          projectId: item.id as string,
          label: item.name || item.root.split(/[\\/]/).pop(),
        })),
    ];
    const results = await Promise.allSettled(
      owners.map((owner) =>
        owner.scope === "user"
          ? action("resources", { operation: "skills", scope: "user" })
          : action("resources", {
              operation: "skills",
              scope: "project",
              projectId: owner.projectId,
            }),
      ),
    );
    if (generation.current !== version) return;
    const failures: { source: string | UiMessage; error: string }[] = [];
    setItems(
      results.flatMap((result, index) => {
        const owner = owners[index];
        if (result.status === "rejected") {
          failures.push({ source: owner.label, error: result.reason.message });
          return [];
        }
        return (result.value.data ?? []).map((item) => ({
          ...item,
          key: `${owner.scope}:${owner.projectId || "user"}:${item.id}`,
          scope: owner.scope,
          projectId: owner.projectId,
          sourceLabel: owner.label,
          catalogRevision: result.value.revision,
        }));
      }),
    );
    setError("");
    setLoadFailures(failures);
  }, [action, projectKey]);
  useEffect(() => {
    void refresh();
    const changed = () => void refresh();
    window.addEventListener("areal-plugins-changed", changed);
    return () => {
      generation.current++;
      window.removeEventListener("areal-plugins-changed", changed);
    };
  }, [refresh]);
  useEffect(() => {
    let current = true;
    setContent("");
    if (!selected) return;
    if (selected.scope === "plugin" && !selected.enabled) {
      setContentLoading(false);
      setError("");
      return;
    }
    setContentLoading(true);
    setError("");
    setLoadFailures([]);
    void skillBody(
      action,
      selected,
      projects.find((item) => item.id === selected.projectId) ?? project,
    )
      .then((value) => {
        if (current) setContent(value);
      })
      .catch((cause) => {
        if (current) setError(cause instanceof UiMessageError ? cause.descriptor : cause.message);
      })
      .finally(() => {
        if (current) setContentLoading(false);
      });
    return () => {
      current = false;
    };
  }, [selected?.key, selected?.revision, action, project?.state?.connected]);
  const displayedError = [
    formatUiMessage(t, error),
    ...loadFailures.map((failure) => `${formatUiMessage(t, failure.source)} · ${failure.error}`),
  ]
    .filter(Boolean)
    .join(" ");
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setLoadFailures([]);
    setMessage("");
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError(cause instanceof UiMessageError ? cause.descriptor : (cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (skill: CenterSkill) =>
    run(async () => {
      if (skill.scope === "plugin" || skill.catalogRevision === undefined) return;
      const request = {
        operation: "skillToggle",
        id: skill.id,
        enabled: !skill.enabled,
        expectedRevision: skill.catalogRevision,
      } satisfies Omit<
        Extract<import("../services.js").CommandParams<"resources">, { operation: "skillToggle" }>,
        "scope" | "projectId"
      >;
      await action("resources", { ...request, ...skillOwner(skill) });
      setMessage({ id: "settings.pluginSkillsPage.savedChangesTakeEffectInNewTasks" });
    });
  const startDraft = (skill: CenterSkill) =>
    run(async () => {
      if (skill.revision === undefined || skill.description === undefined)
        throw new Error(skill.error);
      const draftVersion = draftGeneration.current;
      if (skill.scope === "plugin") {
        if (!project?.state?.connected || !skill.pluginId)
          throw new UiMessageError({
            id: "settings.pluginSkillsPage.connectTheOwningProjectToReadThe",
          });
        const owner = await action("manage", {
          operation: "plugin",
          projectId: project.id,
          id: skill.pluginId,
        });
        if (
          !owner.installed ||
          !owner.installedDigest ||
          !(owner.installedSkills ?? []).some(
            (item: Data) => item.id === skill.id && item.revision === skill.revision,
          )
        )
          throw new UiMessageError({ id: "settings.pluginCenter.hostReadinessUnavailable" });
        const readiness = await action("manage", {
          operation: "pluginReadiness",
          projectId: project.id,
          id: skill.pluginId,
          expectedDigest: owner.installedDigest,
        });
        if (!readiness.available)
          throw new UiMessageError({
            id: "settings.pluginCenter.requiredHostToolsUnavailable",
            values: { tools: readiness.missingTools.join(", ") },
          });
      }
      if (!activeRef.current || draftVersion !== draftGeneration.current) return;
      await onStartDraft({
        text: t("settings.pluginSkillsPage.pleaseUseValueToHelpMeComplete", { value0: skill.name }),
        skill: {
          id: skill.id,
          revision: skill.revision,
          name: skill.name,
          description: skill.description,
          source: sourceLabel(skill),
        },
      });
    });
  if (selected)
    return (
      <article className="plugin-detail-page" data-testid="skill-detail-page">
        <header className="plugin-detail-header">
          <span className="plugin-resource-icon">
            <BookOpen size={28} />
          </span>
          <div>
            <h1>{selected.name}</h1>
            <p>{selected.description}</p>
          </div>
          <div className="plugin-detail-actions">
            {selected.pluginId && (
              <Button variant="outline" onClick={() => onManagePlugin(selected.pluginId!)}>
                {t("settings.pluginSkillsPage.managePlugin")}
              </Button>
            )}
            <Button
              disabled={busy || !selected.enabled || !!selected.error}
              onClick={() => void startDraft(selected)}
            >
              {t("settings.pluginSkillsPage.tryIt")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("settings.pluginSkillsPage.moreSkillActions")}
                  >
                    <MoreHorizontal size={18} />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(selected.id)}>
                  {t("settings.pluginSkillsPage.copySkillID")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <Feedback error={displayedError} message={message} />
        <dl className="plugin-metadata">
          <dt>{t("settings.pluginSkillsPage.source")}</dt>
          <dd>{sourceLabel(selected)}</dd>
          <dt>{t("settings.pluginSkillsPage.skillID")}</dt>
          <dd>{selected.id}</dd>
          <dt>{t("settings.pluginSkillsPage.version")}</dt>
          <dd>{selected.revision}</dd>
          <dt>{t("settings.pluginSkillsPage.status")}</dt>
          <dd>
            {selected.enabled
              ? t("settings.pluginSkillsPage.enabled")
              : t("settings.pluginSkillsPage.disabled")}
          </dd>
        </dl>
        {selected.scope === "plugin" && !selected.enabled && (
          <p role="status">{t("settings.pluginSkillsPage.enableTheOwningPluginToReadThe")}</p>
        )}
        {contentLoading && (
          <p role="status">{t("settings.pluginSkillsPage.loadingSkillContent")}</p>
        )}
        <div className="plugin-skill-content">
          <MessageResponse>{content}</MessageResponse>
        </div>
      </article>
    );
  const all = [...items, ...packageSkills];
  const matches = (item: CenterSkill) =>
    `${item.name} ${item.id} ${item.description} ${sourceLabel(item)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  const visible = all.filter(matches);
  const owners = [
    { label: t("settings.pluginSkillsPage.personal"), value: "user" },
    ...projects
      .filter((item) => !item.projectless)
      .map((item) => ({
        label: item.name || item.root.split(/[\\/]/).pop(),
        value: item.id as string,
      })),
  ];
  const activeScope = owners.some((owner) => owner.value === scopeId) ? scopeId : "user";
  const scoped = visible.filter((item) =>
    activeScope === "user" ? item.scope === "user" : item.projectId === activeScope,
  );
  const search = (
    <SettingsSearchInput
      aria-label={t("settings.pluginSkillsPage.searchSkills")}
      placeholder={t("settings.pluginSkillsPage.searchSkills2")}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      onClear={() => setQuery("")}
      clearLabel={t("settings.pluginSkillsPage.clearSkillSearch")}
    />
  );
  const row = (item: CenterSkill) => (
    <article
      className="plugin-catalog-row"
      key={item.key}
      aria-label={`${item.name} · ${sourceLabel(item)}`}
    >
      <Button
        unstyled
        data-slot={undefined}
        type="submit"
        className="plugin-row-info"
        aria-label={t("settings.pluginSkillsPage.viewSkillValue", { value0: item.id })}
        disabled={busy || !!item.error}
        onClick={() => onOpen(item)}
      >
        <span className="plugin-resource-icon plugin-skill-icon" aria-hidden="true">
          <svg width="16" height="18" viewBox="0 0 16 18">
            <path d="M8 1 14 4.5 8 8 2 4.5Z" fill="#ffd38a" />
            <path d="M2 4.5 8 8 8 16 2 12.5Z" fill="#ffe8bc" />
            <path d="M8 8 14 4.5 14 12.5 8 16Z" fill="#ad8be5" />
          </svg>
        </span>
        <span>
          <strong title={`${item.name} · ${sourceLabel(item)}`}>{item.name}</strong>
          <small className={compact ? undefined : "sr-only"}>{sourceLabel(item)}</small>
          <small>{item.error || item.description || item.id}</small>
        </span>
      </Button>
      {compact && item.pluginId ? (
        <Button variant="ghost" onClick={() => onManagePlugin(item.pluginId!)}>
          {t("settings.pluginSkillsPage.managePlugin")}
        </Button>
      ) : compact ? (
        <Switch
          aria-label={t("settings.pluginSkillsPage.valueSkillValue", {
            value0: item.enabled
              ? t("settings.pluginSkillsPage.disable")
              : t("settings.pluginSkillsPage.enable"),
            value1: item.id,
          })}
          checked={item.enabled}
          disabled={busy || !!item.error}
          onCheckedChange={() => void toggle(item)}
        />
      ) : (
        item.enabled && (
          <Check
            size={14}
            className="plugin-skill-installed"
            aria-label={t("settings.pluginSkillsPage.enabled")}
          />
        )
      )}
    </article>
  );
  const preview = (values: CenterSkill[], key: string, label: string) => {
    const shown = expanded[key] || query.trim() ? values : values.slice(0, 6);
    const id = `${listId}-${key}`;
    return (
      <section className="plugin-skill-section" aria-label={label}>
        <div id={id} className="plugin-catalog-grid">
          {shown.map(row)}
        </div>
        {!values.length && (
          <p className="plugin-skill-empty">
            {query.trim()
              ? t("settings.pluginSkillsPage.noMatchingSkills")
              : t("settings.pluginSkillsPage.noSkillsInstalled")}
          </p>
        )}
        {values.length > 6 && !query.trim() && (
          <Button
            unstyled
            data-slot={undefined}
            type="submit"
            className="plugin-skills-more"
            aria-expanded={!!expanded[key]}
            aria-controls={id}
            onClick={() => setExpanded((current) => ({ ...current, [key]: !current[key] }))}
          >
            {expanded[key]
              ? t("settings.pluginSkillsPage.collapse")
              : t("settings.pluginSkillsPage.showMoreValueMoreSkills", {
                  value0: values.length - 6,
                })}
          </Button>
        )}
      </section>
    );
  };
  if (compact)
    return (
      <section className="plugin-skills plugin-skills-compact">
        <div className="plugin-skills-toolbar">
          <h2>
            {t("settings.pluginSkillsPage.installed")}
            <small>{intl.formatNumber(all.length)}</small>
          </h2>
          {search}
          <Button disabled={createBusy} onClick={onCreate}>
            {t("settings.pluginSkillsPage.createSkill")}
          </Button>
        </div>
        <Feedback error={displayedError} message={message} />
        <div className="plugin-row-list">{visible.map(row)}</div>
        {!visible.length && (
          <div className="resource-empty">
            <BookOpen size={28} />
            <strong>
              {query
                ? t("settings.pluginSkillsPage.noMatchingSkills")
                : t("settings.pluginSkillsPage.noSkillsInstalled")}
            </strong>
            <p>
              {query
                ? t("settings.pluginSkillsPage.tryAnotherNameOrKeyword")
                : t("settings.pluginSkillsPage.createAReusableSkillOrInstallOne")}
            </p>
          </div>
        )}
      </section>
    );
  return (
    <section className="plugin-skills plugin-skills-workspace">
      <header className="plugin-center-header plugin-skills-header">
        <div>
          <h1>Skills</h1>
          <p>{t("settings.pluginSkillsPage.addReusableExpertiseForDifferentTasks")}</p>
        </div>
        <div className="plugin-center-toolbar">
          {search}
          <Button
            disabled={createBusy}
            onClick={onCreate}
            title={t("settings.pluginSkillsPage.createASkillInValue", {
              value0: project?.name || t("settings.pluginSkillsPage.selectedProject"),
            })}
          >
            {t("settings.pluginSkillsPage.createSkill")}
          </Button>
        </div>
      </header>
      <Feedback error={displayedError} message={message} />
      <div className="plugin-skill-section-heading">
        <h2>
          {t("settings.pluginSkillsPage.installed")}
          <small>{intl.formatNumber(all.length)}</small>
        </h2>
      </div>
      {preview(visible, "installed", t("settings.pluginSkillsPage.installedSkills"))}
      <div className="plugin-skill-source-tabs">
        <SettingsSegmentedTabs
          ariaLabel={t("settings.pluginSkillsPage.skillSource")}
          items={owners}
          value={activeScope}
          onValueChange={setScopeId}
        />
      </div>
      {preview(
        scoped,
        `scope-${activeScope}`,
        t("settings.pluginSkillsPage.skillsForValue", {
          value0: owners.find((owner) => owner.value === activeScope)?.label,
        }),
      )}
    </section>
  );
}
