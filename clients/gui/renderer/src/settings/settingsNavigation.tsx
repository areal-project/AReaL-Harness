import { Camera, Cpu, Database, GitFork, Monitor, Server, Smartphone } from "lucide-react";
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
      {
        id: "常规",
        keywords: "settings.search.general",
        label: "settings.general.title",
        icon: <SettingsGeneralIcon />,
      },
      {
        id: "外观",
        keywords: "settings.search.appearance",
        label: "settings.appearance.title",
        icon: <SettingsAppearanceIcon />,
      },
      {
        id: "用量",
        keywords: "settings.search.usage",
        label: "settings.usage.title",
        icon: <SettingsUsageIcon />,
      },
    ],
  },
  {
    id: "integrations",
    label: "settings.navigation.integrations",
    items: [
      {
        id: "插件",
        keywords: "settings.search.plugins",
        label: "settings.plugins.title",
        icon: <SettingsPluginIcon />,
      },
      { id: "SnapShots", label: "settings.snapshots.title", icon: <Camera strokeWidth={1.5} /> },
      {
        id: "浏览器",
        keywords: "settings.search.browser",
        label: "settings.browser.title",
        icon: <SettingsBrowserIcon />,
      },
      {
        id: "电脑控制",
        keywords: "settings.search.computer",
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
        keywords: "settings.search.worktrees",
        label: "settings.worktrees.title",
        icon: <GitFork strokeWidth={1.5} />,
      },
      {
        id: "钩子",
        keywords: "settings.search.hooks",
        label: "settings.hooks.title",
        icon: <SettingsHooksIcon />,
      },
      {
        id: "模型服务",
        keywords: "settings.search.models",
        label: "settings.models.title",
        icon: <Cpu strokeWidth={1.5} />,
      },
      {
        id: "会话配置",
        keywords: "settings.search.session",
        label: "settings.session.title",
        icon: <SettingsConfigurationIcon />,
      },
      {
        id: "Cloud",
        keywords: "settings.search.cloud",
        label: "settings.cloud.title",
        icon: <Server strokeWidth={1.5} />,
      },
      {
        id: "数据飞轮",
        keywords: "settings.search.trajectory",
        label: "settings.trajectory.title",
        icon: <Database strokeWidth={1.5} />,
      },
      {
        id: "手机连接",
        keywords: "settings.search.mobile",
        label: "settings.mobile.title",
        icon: <Smartphone strokeWidth={1.5} />,
      },
    ],
  },
] as const satisfies readonly SettingsNavigationGroup[];

export function settingsLabel(name: string, t: ReturnType<typeof useI18n>["t"]) {
  if (["高级诊断", "后台服务"].includes(name)) return t("settings.service.title");
  const item = settingsNavigationGroups
    .flatMap((group) => group.items.map((item) => ({ id: item.id, label: item.label })))
    .find((item) =>
      ["Skills", "MCP"].includes(name) ? item.label === "settings.plugins.title" : item.id === name,
    );
  return item ? t(item.label) : name;
}
