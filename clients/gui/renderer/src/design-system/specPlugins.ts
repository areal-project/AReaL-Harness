import fixture from "../../../../../design/spec/fixtures/send-run-stop.json";
import type { Data } from "../services.js";

const digest = "a".repeat(64);
const support = (components: string[]) => ({
  supported: true,
  components: components.map((kind) => ({ kind, supported: true })),
});

function entry(plugin: (typeof fixture.plugins.list)[number]): Data {
  const metadata = {
    displayName: plugin.displayName,
    description: plugin.description,
    interface: { developerName: plugin.developer },
  };
  return {
    id: plugin.id,
    name: plugin.name,
    displayName: plugin.displayName,
    description: plugin.description,
    interface: { developerName: plugin.developer },
    version: "1.0.0",
    revision: 1,
    sourceKind: "marketplace",
    source: `/${fixture.plugins.marketplace}/${plugin.name}`,
    sourceDigest: digest,
    catalogSource: { type: "local", path: `/${fixture.plugins.marketplace}/${plugin.name}` },
    installed: plugin.installed,
    enabled: plugin.installed,
    installedVersion: plugin.installed ? "1.0.0" : null,
    installedDigest: plugin.installed ? digest : null,
    installedMetadata: plugin.installed ? metadata : null,
    installedSkills: [],
    installedOnboardingSkill: null,
    componentSupport: support(plugin.components),
    installedComponentSupport: plugin.installed ? support(plugin.components) : null,
    componentChoices: { disabledSkills: [], disabledMcpServers: [] },
    userConfiguration: { revision: 1, missingRequired: [], fields: {} },
    developmentLink: null,
    components: plugin.components,
    diagnostics: [],
    skills: [],
    onboardingSkill: null,
  };
}

// 插件中心的示例后台：只答读取，写操作原样返回当前快照。
export function pluginAction(request: Data): Data | undefined {
  const list = {
    revision: 1,
    data: fixture.plugins.list.map(entry),
    marketplaces: [
      { name: fixture.plugins.marketplace, root: "/", sourceUrl: fixture.plugins.sourceUrl },
    ],
    errors: [],
  };
  switch (request.operation) {
    case "pluginStoreSnapshot":
      return {
        revision: 1,
        scope: { kind: "project", workspace: `/${fixture.project.name}` },
        observedAt: 0,
        runtimeObserved: false,
        list,
        detail: request.id
          ? (list.data.find((item: Data) => item.id === request.id) ?? null)
          : null,
      };
    case "pluginCapabilities":
      return { enabled: true };
    case "pluginMcp":
    case "pluginHooks":
    case "skills":
      return { data: [] };
    case "plugins":
      return list;
    case "pluginReadiness":
      return {
        pluginId: request.id,
        installedDigest: digest,
        requiredTools: [],
        missingTools: [],
        available: true,
      };
    case "pluginComponents":
      return {
        pluginId: request.id,
        installedDigest: digest,
        commands: [],
        agents: [],
        agentDiagnostics: [],
        developmentError: null,
        mcpServers: [],
        apps: [],
        appsNeedingAuth: [],
      };
    default:
      return undefined;
  }
}
