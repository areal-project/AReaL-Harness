import { ComposerMcpIcon } from "./ComposerIcons.js";
import { AttachmentIcon, FileTree, GoalIcon, PlanModeIcon } from "./interfaceIcons.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import type { useI18n } from "./i18n/IntlProvider.js";

type Feature = { disabled?: boolean; run: () => void };

// 斜杠菜单“功能”组：新对话和已有对话用同一组文案、图标和顺序；不可用的项不传。
export function composerFeatureEntries(
  t: ReturnType<typeof useI18n>["t"],
  features: {
    upload: Feature;
    mcp?: Feature;
    files?: Feature;
    plan: Feature & { active: boolean };
    goal?: Feature & { active: boolean };
  },
): ComposerCatalogEntry[] {
  const { upload, mcp, files, plan, goal } = features;
  return [
    {
      value: "upload",
      label: t("chat.composer.uploadFiles"),
      description: t("chat.composer.uploadFilesDescription"),
      icon: <AttachmentIcon />,
      group: "功能",
      ...upload,
    },
    ...(mcp
      ? [
          {
            value: "mcp",
            label: "MCP",
            description: t("chat.composer.mcpDescription"),
            icon: <ComposerMcpIcon />,
            group: "功能" as const,
            ...mcp,
          },
        ]
      : []),
    ...(files
      ? [
          {
            value: "files",
            label: t("chat.composer.workspaceFiles"),
            description: t("chat.composer.workspaceFilesDescription"),
            icon: <FileTree />,
            group: "功能" as const,
            ...files,
          },
        ]
      : []),
    {
      value: "plan",
      label: t("chat.composer.planMode"),
      description: t(
        plan.active
          ? "chat.composer.planModeDisableDescription"
          : "chat.composer.planModeEnableDescription",
      ),
      icon: <PlanModeIcon />,
      group: "功能",
      disabled: plan.disabled,
      run: plan.run,
    },
    ...(goal
      ? [
          {
            value: "goal",
            label: t("chat.composer.setGoal"),
            description: t(
              goal.active
                ? "chat.composer.goalModeDisableDescription"
                : "chat.composer.goalModeEnableDescription",
            ),
            icon: <GoalIcon />,
            group: "功能" as const,
            disabled: goal.disabled,
            run: goal.run,
          },
        ]
      : []),
  ];
}
