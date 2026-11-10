import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { projectUserState } from "../state/userStates.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { useState } from "react";
import { ActionButton } from "../components/ui/action-button.js";
import { SettingsDialog } from "./common.js";

import type { Data } from "../services.js";

/** Read-only deployment projection; viewing it never connects or starts Core. */
export function CoreCapabilitiesSettings({
  projects,
  connected,
}: {
  projects: Data[];
  connected: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title={t("settings.coreCapabilitiesSettings.runtimeEnvironment")}>
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.coreCapabilitiesSettings.coreConnectionAndCapabilities")}
          control={
            <ActionButton onClick={() => setOpen(true)}>
              {t("settings.coreCapabilitiesSettings.viewDetails")}
            </ActionButton>
          }
        />
      </SettingsGroupCard>
      {open && (
        <SettingsDialog
          title={t("settings.coreCapabilitiesSettings.coreConnectionAndCapabilities")}
          description={t(
            "settings.coreCapabilitiesSettings.runtimeEnvironmentAndFeatureSupportForEach",
          )}
          onClose={() => setOpen(false)}
        >
          <div className="settings-sections">
            {!projects.length && (
              <p role="status">
                {t("settings.coreCapabilitiesSettings.noWorkspaceIsConnectedCapabilitiesHaveNot")}
              </p>
            )}
            {projects.map((project) => {
              const core = project.core,
                available = connected && projectUserState(project).canAct;
              const error = project.error || project.state?.error;
              return (
                <SettingsGroupCard key={project.id}>
                  <SettingsRow
                    label={
                      project.root.split(/[\\/]/).filter(Boolean).at(-1) ||
                      t("settings.coreCapabilitiesSettings.workspace")
                    }
                    control={
                      <span>
                        {available
                          ? t("settings.coreCapabilitiesSettings.coreConnected")
                          : t(
                              "settings.coreCapabilitiesSettings.coreDisconnectedPreviousCapabilityInformationMayBe",
                            )}
                      </span>
                    }
                  />
                  {error && (
                    <p role="alert" className="px-4 text-destructive">
                      {error}
                    </p>
                  )}
                  {core?.binary && (
                    <SettingsRow
                      control={null}
                      label={t("settings.coreCapabilitiesSettings.coreExecutable")}
                      description={<span className="break-all">{core.binary}</span>}
                    />
                  )}
                  {core?.apiVersion && (
                    <SettingsRow
                      label={t("settings.coreCapabilitiesSettings.coreAPIVersion")}
                      control={<span>{core.apiVersion}</span>}
                    />
                  )}
                  {core?.runtimeEpoch && (
                    <SettingsRow
                      control={null}
                      label={t("settings.coreCapabilitiesSettings.runtimeInstance")}
                      description={<span className="break-all">{core.runtimeEpoch}</span>}
                    />
                  )}
                  {!core?.features ? (
                    <p role="status" className="px-4">
                      {t(
                        "settings.coreCapabilitiesSettings.coreCapabilitiesAreNotAvailableYetCheck",
                      )}
                    </p>
                  ) : (
                    <>
                      <SettingsRow
                        control={null}
                        label={t("settings.coreCapabilitiesSettings.sessionsAndConversations")}
                        description={
                          core.features.conversation
                            ? t("settings.coreCapabilitiesSettings.conversationExecutionAvailable")
                            : t(
                                "settings.coreCapabilitiesSettings.thisCoreDoesNotProvideConversationExecution",
                              )
                        }
                      />
                      <SettingsRow
                        control={null}
                        label={t("settings.coreCapabilitiesSettings.ongoingGoal")}
                        description={
                          core.features.goals
                            ? t("settings.coreCapabilitiesSettings.ongoingGoalsAvailable")
                            : t(
                                "settings.coreCapabilitiesSettings.thisCoreDoesNotProvideOngoingGoals",
                              )
                        }
                      />
                      <SettingsRow
                        control={null}
                        label={t("settings.coreCapabilitiesSettings.tasksAndInbox")}
                        description={
                          core.features.tasks
                            ? t("settings.coreCapabilitiesSettings.tasksAndInboxAvailable")
                            : t("settings.coreCapabilitiesSettings.thisCoreDoesNotProvideTasksAnd")
                        }
                      />
                      <SettingsRow
                        control={null}
                        label={t("settings.coreCapabilitiesSettings.managedProcessesAndTerminals")}
                        description={
                          core.features.processes
                            ? t(
                                "settings.coreCapabilitiesSettings.managedProcessesAndTerminalsAvailable",
                              )
                            : core.runtimeAvailable === false
                              ? t(
                                  "settings.coreCapabilitiesSettings.thisCoreIsNotConnectedToRuntime",
                                )
                              : t(
                                  "settings.coreCapabilitiesSettings.thisCoreDoesNotProvideFullManaged",
                                )
                        }
                      />
                      <SettingsRow
                        control={null}
                        label={t("settings.coreCapabilitiesSettings.subtaskExecution")}
                        description={
                          core.features.executions
                            ? t(
                                "settings.coreCapabilitiesSettings.coreSchedulesSubtasksAndReturnsTheirProgress",
                              )
                            : t(
                                "settings.coreCapabilitiesSettings.thisCoreDoesNotProvideTheUnified",
                              )
                        }
                      />
                    </>
                  )}
                </SettingsGroupCard>
              );
            })}
          </div>
        </SettingsDialog>
      )}
    </SettingsSection>
  );
}
