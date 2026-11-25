import { Beaker, Camera, Cpu, Database, GitFork, Server, Smartphone } from "lucide-react";
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
        id: "general",
        keywords: "settings.search.general",
        label: "settings.general.title",
        icon: <SettingsGeneralIcon />,
      },
      {
        id: "appearance",
        keywords: "settings.search.appearance",
        label: "settings.appearance.title",
        icon: <SettingsAppearanceIcon />,
      },
      {
        id: "usage",
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
        id: "plugins",
        keywords: "settings.search.plugins",
        label: "settings.plugins.title",
        icon: <SettingsPluginIcon />,
      },
      { id: "SnapShots", label: "settings.snapshots.title", icon: <Camera strokeWidth={1.5} /> },
      {
        id: "browser",
        keywords: "settings.search.browser",
        label: "settings.browser.title",
        icon: <SettingsBrowserIcon />,
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
        id: "hooks",
        keywords: "settings.search.hooks",
        label: "settings.hooks.title",
        icon: <SettingsHooksIcon />,
      },
      {
        id: "providers",
        keywords: "settings.search.models",
        label: "settings.models.title",
        icon: <Cpu strokeWidth={1.5} />,
      },
      {
        id: "session",
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
        id: "trajectory",
        keywords: "settings.search.trajectory",
        label: "settings.trajectory.title",
        icon: <Database strokeWidth={1.5} />,
      },
      {
        id: "mobile",
        keywords: "settings.search.mobile",
        label: "settings.mobile.title",
        icon: <Smartphone strokeWidth={1.5} />,
      },
    ],
  },
  {
    id: "labs",
    label: "settings.navigation.labs",
    items: [
      {
        id: "Labs",
        keywords: "settings.search.labs",
        label: "settings.labs.title",
        icon: <Beaker strokeWidth={1.5} />,
      },
    ],
  },
] as const satisfies readonly SettingsNavigationGroup[];

const settingsSubtitles = {
  browser: "settings.browser.subtitle",
  Worktrees: "worktree.settings.description",
  mobile: "settings.mobileConnect.intro",
  hooks: "settings.hooksSettings.runToolEventCommandsInOrderRestart",
  Labs: "settings.labs.description",
} as const;

/** 页面说明放在标题下面，和标题算一组，不和第一个分区挤在一起。 */
export function settingsSubtitle(name: string, t: ReturnType<typeof useI18n>["t"]) {
  return name in settingsSubtitles
    ? t(settingsSubtitles[name as keyof typeof settingsSubtitles])
    : undefined;
}

export function settingsLabel(name: string, t: ReturnType<typeof useI18n>["t"]) {
  if (name === "diagnostics") return t("settings.service.title");
  const item = settingsNavigationGroups
    .flatMap((group) => group.items.map((item) => ({ id: item.id, label: item.label })))
    .find((item) =>
      ["Skills", "MCP"].includes(name) ? item.label === "settings.plugins.title" : item.id === name,
    );
  return item ? t(item.label) : name;
}
