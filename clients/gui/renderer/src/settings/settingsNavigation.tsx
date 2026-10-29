import { Cpu, Database, GitFork, Monitor, Server, Smartphone } from "lucide-react";
import type { useI18n } from "../i18n/IntlProvider.js";
import {
  SettingsAppearanceIcon,
  SettingsBrowserIcon,
  SettingsConfigurationIcon,
  SettingsGeneralIcon,
  SettingsHooksIcon,
  SettingsPluginIcon,
  SettingsUsageIcon,
} from "./settingsNavIcons.js";
import type { SettingsNavigationGroup } from "./SettingsWorkspace.js";
export const settingsNavigationGroups = [
  {
    id: "personal",
    label: "settings.navigation.personal",
    items: [
      { id: "常规", label: "settings.general.title", icon: <SettingsGeneralIcon /> },
      { id: "外观", label: "settings.appearance.title", icon: <SettingsAppearanceIcon /> },
      { id: "用量", label: "settings.usage.title", icon: <SettingsUsageIcon /> },
    ],
  },
  {
    id: "integrations",
    label: "settings.navigation.integrations",
    items: [
      { id: "插件", label: "settings.plugins.title", icon: <SettingsPluginIcon /> },
      { id: "浏览器", label: "settings.browser.title", icon: <SettingsBrowserIcon /> },
      {
        id: "电脑控制",
        label: "settings.computer.title",
        icon: <Monitor strokeWidth={1.5} />,
      },
    ],
  },
  {
    id: "coding",
    label: "settings.navigation.coding",
    items: [
      {
        id: "Worktrees",
        label: "settings.worktrees.title",
        icon: <GitFork strokeWidth={1.5} />,
      },
      { id: "钩子", label: "settings.hooks.title", icon: <SettingsHooksIcon /> },
      { id: "模型服务", label: "settings.models.title", icon: <Cpu strokeWidth={1.5} /> },
      {
        id: "会话配置",
        label: "settings.session.title",
        icon: <SettingsConfigurationIcon />,
      },
      { id: "Cloud", label: "settings.cloud.title", icon: <Server strokeWidth={1.5} /> },
      { id: "后台服务", label: "settings.service.title", icon: <Server strokeWidth={1.5} /> },
      {
        id: "数据飞轮",
        label: "settings.trajectory.title",
        icon: <Database strokeWidth={1.5} />,
      },
      {
        id: "手机连接",
        label: "settings.mobile.title",
        icon: <Smartphone strokeWidth={1.5} />,
      },
    ],
  },
] as const satisfies readonly SettingsNavigationGroup[];

export function settingsLabel(name: string, t: ReturnType<typeof useI18n>["t"]) {
  const item = settingsNavigationGroups
    .flatMap((group) => group.items.map((item) => ({ id: item.id, label: item.label })))
    .find((item) =>
      ["Skills", "MCP"].includes(name) ? item.label === "settings.plugins.title" : item.id === name,
    );
  return item ? t(item.label) : name;
}
