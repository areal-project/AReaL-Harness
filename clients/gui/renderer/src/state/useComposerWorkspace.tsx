import { useState } from "react";
import { errorText } from "../errors/errorCopy.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { McpAppIcon } from "../McpAppIcon.js";
import type { useMcpAppsWorkspace } from "../McpAppsWorkspace.js";
import type { ComposerCatalogEntry } from "../prompt-editor/ComposerCatalog.js";
import type { Data } from "../services.js";
import { mcpAppEntrypoints, toolTitle } from "../settings/McpAppsSettings.js";
import type { WorktreeSelection } from "../WorktreeStarter.js";

export function useComposerWorkspace(
  project: Data | undefined,
  thread: Data | undefined,
  mcpWorkspace: ReturnType<typeof useMcpAppsWorkspace>,
  setError: (message: string) => void,
) {
  const { t } = useI18n();
  const [mcpMentionsOpen, setMcpMentionsOpen] = useState(false);
  const [worktreeSelections, setWorktreeSelections] = useState<
    Record<string, WorktreeSelection | undefined>
  >({});
  const worktreeSelection = project ? worktreeSelections[project.id] : undefined;
  const changeWorktreeSelection = (pid: string, value: WorktreeSelection | undefined) => {
    setWorktreeSelections((previous) => ({ ...previous, [pid]: value }));
  };
  const appEntries: ComposerCatalogEntry[] = mcpAppEntrypoints(mcpWorkspace.servers, "thread").map(
    ({ server, tool }) => ({
      value: `app:${server.serverId}:${tool.name}`,
      label: toolTitle(tool),
      description: t("chat.composer.openApp"),
      source: server.title ?? server.pluginId,
      keywords: ["app", "应用", "plugin", "插件"],
      icon: (
        <McpAppIcon
          icon={tool.icons?.[0] ?? server.icons?.[0]}
          size={16}
          loadMetadataImage={mcpWorkspace.loadMetadataImage}
        />
      ),
      group: "应用",
      disabled:
        !project?.state?.connected ||
        project.desktopCapabilities?.currentCommands === false ||
        !!thread?.desktop?.archived,
      run: () => {
        void mcpWorkspace
          .openApp(server, tool, { kind: "thread" })
          .catch((cause) => setError(errorText(t, cause)));
      },
    }),
  );
  return {
    worktreeSelection,
    changeWorktreeSelection,
    mcpMentionsOpen,
    setMcpMentionsOpen,
    appEntries,
  };
}
