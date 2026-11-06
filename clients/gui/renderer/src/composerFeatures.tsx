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
      label: "上传文件",
      description: "添加图片、文档或其他文件",
      icon: <AttachmentIcon />,
      group: "功能",
      ...upload,
    },
    ...(mcp
      ? [
          {
            value: "mcp",
            label: "MCP",
            description: "查看服务器与连接状态",
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
      label: "计划模式",
      description: plan.active ? "关闭计划模式" : "先规划，再开始执行",
      icon: <PlanModeIcon />,
      group: "功能",
      disabled: plan.disabled,
      run: plan.run,
    },
    ...(goal
      ? [
          {
            value: "goal",
            label: "设置目标",
            description: goal.active ? "关闭目标模式" : "设置持续目标与停止条件",
            icon: <GoalIcon />,
            group: "功能" as const,
            disabled: goal.disabled,
            run: goal.run,
          },
        ]
      : []),
  ];
}
