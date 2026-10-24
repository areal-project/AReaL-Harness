import { composerDraftStorage } from "./composerDraftStorage.js";
import { useEffect, useState } from "react";
import { Package } from "lucide-react";
import type { Action, Data } from "./services.js";
import type { ComposerSkill } from "./ComposerSkills.js";
import type { ComposerCatalogData } from "./prompt-editor/ComposerCatalog.js";
import { buildPluginMentionMarkdown, parseMentionMarkdown } from "./mentions/mentionMarkdown.js";
import { useI18n } from "./i18n/IntlProvider.js";

type PluginOwner = { projectId: string; coreInstanceId?: string; connectionGeneration?: number; configurationRevision?: number };
export type ComposerPluginContext = PluginOwner & (
  | { kind: "mainThread"; threadId: string }
  | { kind: "mainDraft"; profile?: { id: string; revision: string } }
  | { kind: "sideThread"; threadId: string; sourceThreadId: string }
  | { kind: "sideDraft"; draftId: string; sourceThreadId: string }
);
export type ComposerPluginSelection = { id: string; digest: string; name: string; skills: ComposerSkill[]; mcpServers: string[]; description?: string };
const skillIdentity = (skill: { id: string; revision: string }) => `${skill.id}/${skill.revision}`;
const isSide = (context: ComposerPluginContext) => context.kind === "sideThread" || context.kind === "sideDraft";
const mentionIds = (text: string) => [...new Set(parseMentionMarkdown(text).flatMap(part => part.type === "plugin" && part.pluginId ? [part.pluginId] : []))];
const unavailable = "chat.composer.pluginReferenceUnavailable";

export function readComposerPlugins(key: string): ComposerPluginSelection[] {
  const value: unknown = JSON.parse(composerDraftStorage.getItem(`${key}:plugins`) ?? "[]");
  if (!Array.isArray(value) || value.some(row => typeof row?.id !== "string" || typeof row?.digest !== "string" || typeof row?.name !== "string" || !Array.isArray(row?.skills) || !Array.isArray(row?.mcpServers) || row.mcpServers.some((server: unknown) => typeof server !== "string") || row.skills.some((skill: Data) => typeof skill.id !== "string" || typeof skill.revision !== "string"))) throw new Error(unavailable);
  return value;
}
export const clearComposerPlugins = (key: string) => composerDraftStorage.removeItem(`${key}:plugins`);
export function transferComposerPlugins(from: string, to: string) {
  const value = composerDraftStorage.getItem(`${from}:plugins`);
  if (value) composerDraftStorage.setItem(`${to}:plugins`, value);
}
function writeSelections(key: string, selections: ComposerPluginSelection[]) {
  composerDraftStorage.setItem(`${key}:plugins`, JSON.stringify(selections));
}
function skillScope(context: ComposerPluginContext) {
  if (context.kind === "mainThread") return { threadId: context.threadId };
  if (context.kind === "mainDraft" && context.profile) return { agentProfile: context.profile };
  return null;
}
async function pluginCatalog(action: Action, context: ComposerPluginContext): Promise<ComposerPluginSelection[]> {
  const scope = skillScope(context);
  const [inventory, catalog, connections] = await Promise.all([
    action("manage", { projectId: context.projectId, operation: "plugins" }),
    scope ? action("manage", { projectId: context.projectId, operation: "skills", ...scope }) : Promise.resolve({ data: [] }),
    action("manage", { projectId: context.projectId, operation: "pluginMcp" }),
  ]);
  return (inventory.data ?? []).flatMap((plugin: Data): ComposerPluginSelection[] => {
    const report = plugin.installedComponentSupport;
    if (!plugin.installed || !plugin.enabled || !plugin.installedDigest || !report || report.digest !== plugin.installedDigest || report.compatibility?.state !== "allowed") return [];
    const name = plugin.installedMetadata?.displayName || plugin.installedMetadata?.name || plugin.id;
    const skills = isSide(context) ? [] : (catalog.data ?? []).filter((row: Data) => row.available && row.pluginId === plugin.id).map((row: Data) => ({
      id: row.id, revision: row.revision, name: row.name ?? row.id, description: row.description ?? "", source: name,
    }));
    const connection = (connections.data ?? []).find((row: Data) => row.pluginId === plugin.id && row.installedDigest === plugin.installedDigest);
    const supportedMcp = report.components.some((row: Data) => row.kind === "mcp" && row.status !== "unsupported");
    const mcpServers: string[] = supportedMcp ? (connection?.servers ?? []).filter((row: Data) => row.projectEnabled === true && row.config?.enabled === true && row.state !== "disabled").map((row: Data) => row.serverId) : [];
    const hasSkills = report.components.some((row: Data) => row.kind === "skills" && row.status !== "unsupported") && plugin.installedSkills?.some((row: Data) => !(plugin.componentChoices?.disabledSkills ?? []).includes(row.id));
    if (!skills.length && !mcpServers.length && !(isSide(context) && hasSkills)) return [];
    return [{ id: plugin.id, digest: plugin.installedDigest, name, skills, mcpServers, description: plugin.installedMetadata?.description ?? "" }];
  });
}

export async function revalidateComposerPlugins(action: Action, context: ComposerPluginContext, key: string, text: string, unavailableMessage: string) {
  const ids = mentionIds(text);
  if (!ids.length) { clearComposerPlugins(key); return []; }
  let captured: ComposerPluginSelection[];
  try { captured = readComposerPlugins(key).filter(row => ids.includes(row.id)); }
  catch { throw new Error(unavailableMessage); }
  const catalog = await pluginCatalog(action, context);
  const selected = ids.map(id => {
    const current = catalog.find(row => row.id === id);
    const previous = captured.find(row => row.id === id);
    if (!current || previous && (previous.digest !== current.digest || previous.skills.some(skill => !current.skills.some(row => skillIdentity(row) === skillIdentity(skill))) || previous.mcpServers.some(server => !current.mcpServers.includes(server)))) throw new Error(unavailableMessage);
    return previous ?? current;
  });
  writeSelections(key, selected);
  return selected;
}
export function composerPluginIntent(selected: ComposerPluginSelection[], intent: (name: string) => string) {
  return selected.map(row => intent(row.name)).join("\n");
}
export function mergeComposerPluginSkills(manual: ComposerSkill[], plugins: ComposerPluginSelection[]) {
  return [...new Map([...manual, ...plugins.flatMap(row => row.skills)].map(row => [skillIdentity(row), row])).values()];
}

export function useComposerPlugins({ project, context, draftKey, action, text, onMcpMention }: {
  project: Data; context: ComposerPluginContext; draftKey: string; action: Action; text: string; onMcpMention?: () => void;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<{ owner: string; rows: ComposerPluginSelection[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const contextKey = JSON.stringify(context);
  const catalog = snapshot?.owner === contextKey && project.state?.connected ? snapshot.rows : [];
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener("areal-plugins-changed", changed);
    return () => window.removeEventListener("areal-plugins-changed", changed);
  }, []);
  useEffect(() => {
    let active = true;
    setError(""); setLoading(false);
    if (!project.state?.connected) return;
    setLoading(true);
    void pluginCatalog(action, context).then(rows => {
      if (active) { setSnapshot({ owner: contextKey, rows }); setLoading(false); }
    }).catch(() => { if (active) { setSnapshot(null); setError(t("chat.composer.pluginReferenceUnavailable")); setLoading(false); } });
    return () => { active = false; };
  }, [contextKey, project.state?.connected, revision]);
  useEffect(() => {
    const ids = mentionIds(text);
    try {
      const previous = readComposerPlugins(draftKey);
      const next = ids.flatMap(id => {
        const row = previous.find(value => value.id === id) ?? catalog.find(value => value.id === id);
        return row ? [row] : [];
      });
      writeSelections(draftKey, next);
    } catch { setError(t("chat.composer.pluginReferenceUnavailable")); }
  }, [text, draftKey, catalog]);
  return {
    clear: () => clearComposerPlugins(draftKey),
    catalog: {
      entries: [
        ...catalog.map(row => ({
          value: row.id, label: row.name, description: row.description ?? "", source: isSide(context) ? t("chat.composer.pluginReferenceOnly") : undefined, group: "应用" as const, icon: <Package size={16} />,
          mention: { id: `plugin:${row.id}`, category: "plugins" as const, label: row.name, value: row.id, description: row.description, markdown: buildPluginMentionMarkdown(row.name, row.id), data: { pluginId: row.id } },
          run: () => {
            const previous = readComposerPlugins(draftKey);
            writeSelections(draftKey, [...previous.filter(item => item.id !== row.id), row]);
          },
        })),
        ...(onMcpMention ? [{ value: "mcp-resources", label: t("chat.composer.mcpResourceReference"), description: t("chat.composer.mcpResourceReferenceDescription"), group: "功能" as const, icon: <Package size={16} />, run: onMcpMention }] : []),
      ], loading, error, refresh: () => setRevision(value => value + 1),
      searchLabel: t("chat.composer.searchPluginReferences"), label: t("chat.composer.pluginReferences"),
    } satisfies ComposerCatalogData,
  };
}
