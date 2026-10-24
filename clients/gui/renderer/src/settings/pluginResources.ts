import { useI18n, type UiMessage, type Translate, type MessageId, formatUiMessage } from "../i18n/IntlProvider.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { supportBlocked, type PackageComponentSupport } from "./PluginComponentSupport.js";
import type { Action } from "../services.js";

export type PackageOwner = {
  pluginId: string;
  pluginName: string;
  installedDigest: string;
  enabled: boolean;
  compatibilityBlocked?: boolean;
};
export type PluginSkillResource = {
  key: string;
  id: string;
  name: string;
  description: string;
  owner: PackageOwner;
};
export type PluginMcpResource = {
  key: string;
  serverId: string;
  state: string;
  owner: PackageOwner;
};
type InstalledPackage = {
  id: string;
  displayName: string;
  name: string;
  installed: boolean;
  installedDigest: string | null;
  enabled: boolean;
  installedComponentSupport?: PackageComponentSupport | null;
  componentChoices?: { disabledSkills: string[]; disabledMcpServers: string[] };
  installedSkills: { id: string; name: string; description: string }[];
};
type PluginConnection = {
  pluginId: string;
  installedDigest: string;
  state: string;
  servers: { serverId: string; state: string }[];
  diagnostics: unknown[];
};
type ResourceSnapshot = {
  projectId: string | null;
  skills: PluginSkillResource[];
  mcp: PluginMcpResource[];
  loading: boolean;
  errors: ResourceIssue[];
  notice: UiMessage | null;
};
type ResourceIssue = string | UiMessage | { kind: "diagnostic"; pluginId: string; diagnostic: unknown } | { kind: "catalog" | "mcp"; cause: unknown };
export function pluginSourceLabel(owner: PackageOwner, t: Translate) {
  return t("settings.pluginResources.pluginSourceLabel", { value0: owner.pluginName, value1: owner.pluginId });
}
const mcpStateMessages: Record<string, MessageId> = {
  connected: "settings.pluginResources.connectedState",
  disconnected: "settings.pluginResources.disconnectedState",
  failed: "settings.pluginResources.failedState",
  connecting: "settings.pluginResources.connectingState",
  disabled: "settings.pluginResources.disabledState",
  authRequired: "settings.pluginResources.authRequiredState",
  partial: "settings.pluginResources.partialState",
  cleanupUnknown: "settings.pluginResources.cleanupUnknownState",
  authentication: "settings.pluginResources.authenticationState",
  startup: "settings.pluginResources.startupState",
  discovery: "settings.pluginResources.discoveryState",
  stale: "settings.pluginResources.staleState",
  notApplied: "settings.pluginResources.notAppliedState",
  unknown: "settings.pluginResources.unknownState",
  unsupported: "settings.pluginResources.unsupportedState",
  missingMapping: "settings.pluginResources.missingMappingState",
  configuration: "settings.pluginResources.configurationState",
  policy: "settings.pluginResources.policyState",
};
export function pluginMcpStateLabel(state: string, t: Translate) {
  return t(mcpStateMessages[state] ?? "settings.pluginResources.unknownStateDetails");
}
function diagnosticText(value: unknown, t: Translate): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const diagnostic = value as { serverId?: unknown; class?: unknown };
    if (typeof diagnostic.class === "string")
      return `${typeof diagnostic.serverId === "string" ? diagnostic.serverId + " · " : ""}${pluginMcpStateLabel(diagnostic.class, t)}`;
  }
  return t("settings.pluginResources.resourceDiagnosticsAvailable");
}
function issueText(issue: ResourceIssue, t: Translate): string {
  if (typeof issue === "string" || "id" in issue) return formatUiMessage(t, issue);
  if (issue.kind === "diagnostic") return t("settings.pluginResources.pluginDiagnostic", { value0: issue.pluginId, value1: diagnosticText(issue.diagnostic, t) });
  const text = issue.cause instanceof Error ? issue.cause.message : t("settings.pluginResources.readFailed");
  return t(issue.kind === "catalog" ? "settings.pluginResources.pluginCatalogValue" : "settings.pluginResources.pluginMCPValue", { value0: text });
}

export function useInstalledPluginResources(
  projectId: string | null,
  connected: boolean,
  action: Action,
) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ResourceSnapshot>({
    projectId: null, skills: [], mcp: [], loading: false, errors: [], notice: null,
  });
  const generation = useRef(0);
  const actionRef = useRef(action);
  actionRef.current = action;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const next: ResourceSnapshot = { projectId, skills: [], mcp: [], loading: false, errors: [], notice: null };
    if (!projectId || !connected) {
      setSnapshot(next);
      return;
    }
    setSnapshot({ ...next, loading: true });
    const api = (operation: string) => actionRef.current("manage", { operation, projectId });
    try {
      const capability = await api("pluginCapabilities");
      if (request !== generation.current) return;
      if (!capability.enabled) {
        next.notice = { id: "settings.pluginResources.thePluginCatalogIsDisabledInThis" };
        setSnapshot(next);
        return;
      }
      const [catalog, connections] = await Promise.allSettled([api("plugins"), api("pluginMcp")]);
      if (request !== generation.current) return;
      const errors: ResourceIssue[] = [];
      const owners = new Map<string, PackageOwner>();
      if (catalog.status === "fulfilled") {
        const packages: InstalledPackage[] = catalog.value.data;
        for (const item of packages) {
          if (!item.installed || !item.installedDigest) continue;
          const owner: PackageOwner = {
            pluginId: item.id,
            pluginName: item.displayName || item.name,
            installedDigest: item.installedDigest,
            enabled: item.enabled,
            compatibilityBlocked: supportBlocked(item.installedComponentSupport, item.installedDigest),
          };
          owners.set(item.id, owner);
          for (const skill of item.installedSkills) {
            next.skills.push({
              key: JSON.stringify([item.id, item.installedDigest, "skill", skill.id]),
              id: skill.id, name: skill.name, description: skill.description, owner: { ...owner, enabled: owner.enabled && !item.componentChoices?.disabledSkills.includes(skill.id) },
            });
          }
        }
        errors.push(...catalog.value.errors);
      } else errors.push({ kind: "catalog", cause: catalog.reason });
      if (connections.status === "fulfilled" && catalog.status === "fulfilled") {
        const packages: PluginConnection[] = connections.value.data;
        for (const item of packages) {
          errors.push(...item.diagnostics.map((diagnostic): ResourceIssue => ({ kind: "diagnostic", pluginId: item.pluginId, diagnostic })));
          if (!item.servers.length) continue;
          const owner = owners.get(item.pluginId);
          if (!owner || owner.installedDigest !== item.installedDigest) {
            errors.push({ id: "settings.pluginResources.theInstallationSnapshotForPluginValueChanged", values: { value0: item.pluginId } });
            continue;
          }
          for (const server of item.servers) {
            next.mcp.push({
              key: JSON.stringify([item.pluginId, item.installedDigest, "mcp", server.serverId]),
              serverId: server.serverId, state: server.state ?? item.state, owner,
            });
          }
        }
      } else if (connections.status === "rejected") {
        errors.push({ kind: "mcp", cause: connections.reason });
      }
      next.errors = errors;
      setSnapshot(next);
    } catch (cause) {
      if (request === generation.current) setSnapshot({ ...next, errors: [cause instanceof Error ? cause.message : { id: "settings.pluginResources.readFailed" }] });
    }
  }, [projectId, connected]);
  useEffect(() => {
    const changed = () => void refresh();
    window.addEventListener("areal-plugins-changed", changed);
    void refresh();
    return () => {
      generation.current++;
      window.removeEventListener("areal-plugins-changed", changed);
    };
  }, [refresh]);
  const current: ResourceSnapshot = snapshot.projectId === projectId && connected ? snapshot : {
    projectId, skills: [], mcp: [], loading: false, errors: [],
    notice: !projectId ? { id: "settings.pluginResources.selectAProjectToViewInstalledPlugin" } : !connected ? { id: "settings.pluginResources.theProjectIsDisconnectedConnectCoreTo" } : null,
  };
  return { ...current, error: current.errors.map(issue => issueText(issue, t)).join(" "), notice: current.notice ? formatUiMessage(t, current.notice) : "", refresh };
}
