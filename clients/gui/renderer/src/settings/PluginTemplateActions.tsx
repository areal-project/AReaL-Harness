import { useState } from "react";
import type { ManagementResponseMap } from "@areal/workbench/desktop-contract/management";
import type { PluginCommandRef } from "@areal/workbench/desktop-contract/conversation";
import type { PluginDetail } from "./pluginTypes.js";
import type { ResourceDraftSeed } from "./PluginSkillsPage.js";
import { UiMessageError, formatUiMessage, useI18n } from "../i18n/IntlProvider.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Feedback } from "./common.js";

export function PluginTemplateActions({
  detail,
  components,
  disabled,
  onRunCommand,
  onStartDraft,
}: {
  detail: PluginDetail;
  components: ManagementResponseMap["pluginComponents"] | null;
  disabled: boolean;
  onRunCommand?: (command: PluginCommandRef) => Promise<void>;
  onStartDraft: (seed: ResourceDraftSeed) => Promise<void>;
}) {
  const { t } = useI18n();
  const [argumentsByCommand, setArguments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const invoke = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof UiMessageError
          ? formatUiMessage(t, cause.descriptor)
          : cause instanceof Error
            ? cause.message
            : t("settings.pluginCenter.pluginOperationFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  if (!components) return null;
  return (
    <section className="plugin-detail-resources" data-plugin-components>
      <Feedback error={error} />
      {components.commands.length > 0 && (
        <>
          <h3>{t("settings.pluginCenter.commandsTitle")}</h3>
          <p>{t("settings.pluginCenter.commandSubmissionBoundary")}</p>
          {!onRunCommand && <p>{t("settings.pluginCenter.selectTaskForCommand")}</p>}
          <ul className="plugin-component-list">
            {components.commands.map((command) => (
              <li key={command.componentId}>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!onRunCommand) return;
                    void invoke(() =>
                      onRunCommand({
                        pluginId: detail.id,
                        componentId: command.componentId,
                        installedDigest: command.installedDigest,
                        arguments: argumentsByCommand[command.componentId] ?? "",
                      }),
                    );
                  }}
                >
                  <strong>{command.name}</strong>
                  <p>{command.description}</p>
                  <label>
                    {t("settings.pluginCenter.commandArguments")}
                    <Input
                      value={argumentsByCommand[command.componentId] ?? ""}
                      placeholder={command.argumentHint ?? undefined}
                      disabled={disabled || busy}
                      onChange={(event) => {
                        const value = event.target.value;
                        setArguments((previous) => ({ ...previous, [command.componentId]: value }));
                      }}
                    />
                  </label>
                  <Button
                    type="submit"
                    disabled={
                      disabled ||
                      busy ||
                      !detail.enabled ||
                      !onRunCommand ||
                      command.installedDigest !== detail.installedDigest
                    }
                  >
                    {t("settings.pluginCenter.submitCommandToTask")}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}
      {components.agents.length > 0 && (
        <>
          <h3>{t("settings.pluginCenter.agentsTitle")}</h3>
          <p>{t("settings.pluginCenter.agentProfileBoundary")}</p>
          <ul className="plugin-component-list">
            {components.agents.map((agent) => (
              <li key={agent.componentId}>
                <strong>{agent.name}</strong>
                <p>{agent.description}</p>
                <Button
                  variant="outline"
                  disabled={disabled || busy || !detail.enabled}
                  onClick={() =>
                    void invoke(() =>
                      onStartDraft({
                        text: t("settings.pluginCenter.agentDraftPrompt", { name: agent.name }),
                        profile: agent.profile,
                      }),
                    )
                  }
                >
                  {t("settings.pluginCenter.useAgentProfile")}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!components.agentDiagnostics.length && (
        <Feedback error={components.agentDiagnostics.join("\n")} />
      )}
    </section>
  );
}
