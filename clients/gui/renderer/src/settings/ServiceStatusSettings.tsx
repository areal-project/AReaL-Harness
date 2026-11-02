import { DelayedVisible } from "@areal/ui";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { BackendServiceStatus, type BackendStatusProps } from "../BackendStatusNotice.js";
import { useI18n, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "../components/ui/action-button.js";
import { Button } from "../components/ui/button.js";
import { SettingsSwitch } from "./SettingsPageParts.js";
import { SpaceReclamation } from "./SpaceReclamation.js";
import type { Action, CommandResponse, Snapshot } from "../services.js";

type Status = CommandResponse<"serviceStatus">;

export function ServiceStatusSettings({
  connected,
  runningState,
  recovery,
  backendStatus,
  action,
  onConnect,
  onOpen,
  onTask,
}: {
  backendStatus?: BackendStatusProps;
  connected: boolean;
  runningState?: "running" | "stopped" | "unknown";
  action: Action;
  onConnect: () => Promise<void>;
  recovery?: NonNullable<Snapshot["lifecycle"]>["recovery"];
  onTask?: (projectId: string, taskId: string) => void;
  onOpen?: (projectId: string, threadId: string, panel?: string) => void;
}) {
  const { t, intl } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | UiMessage>(""),
    [actionError, setActionError] = useState(""),
    [notice, setNotice] = useState<string | UiMessage>("");
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false),
    [exportNotice, setExportNotice] = useState<string | UiMessage>(""),
    [exportError, setExportError] = useState<string | UiMessage>("");
  const generation = useRef(0),
    locked = useRef(false),
    inflight = useRef<Promise<void> | null>(null);
  const read = useCallback(() => {
    if (!connected) return Promise.resolve();
    if (inflight.current) return inflight.current;
    const ticket = generation.current;
    setReading(true);
    const pending = (async () => {
      try {
        const result: Status = await action("serviceStatus", {});
        if (ticket === generation.current) {
          setStatus(result);
          setReadError("");
        }
      } catch (cause) {
        if (ticket === generation.current)
          setReadError({
            id: "settings.serviceStatusSettings.couldNotReadBackgroundServiceStatusTry",
            values: { value0: (cause as Error).message },
          });
      } finally {
        if (ticket === generation.current) setReading(false);
        inflight.current = null;
      }
    })();
    inflight.current = pending;
    return pending;
  }, [action, connected]);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!locked.current) await read();
      if (live) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      live = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, [read]);
  const run = async (
    operation: "stopService" | "recoverResources" | "connect" | "quitInterface" | "stopAndQuit",
  ) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setActionError("");
    setNotice("");
    let stopped = false;
    try {
      await inflight.current; // Finish this page's read before the native stop fence.
      if (operation === "connect") await onConnect();
      else if (operation === "quitInterface" || operation === "stopAndQuit") {
        const result = await action("serviceLifecycle", { operation });
        stopped =
          ("quitting" in result && result.quitting) || ("stopped" in result && result.stopped);
      } else if (operation === "stopService") {
        const result = await action("stopService", {});
        stopped = "stopped" in result && result.stopped;
        setNotice(
          stopped
            ? { id: "settings.serviceStatusSettings.backgroundServiceStopped" }
            : "canceled" in result
              ? { id: "settings.serviceStatusSettings.stopCanceled" }
              : { id: "settings.serviceStatusSettings.stopResultNeedsConfirmation" },
        );
      } else {
        const result = await action("recoverResources", {});
        if ("recovered" in result && result.recovered) {
          await onConnect();
          setNotice({
            id: "settings.serviceStatusSettings.backgroundServiceRestoredConfigurationAndHistoryWere",
          });
        }
      }
    } catch (cause) {
      setActionError((cause as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
      // A successful stop must stay stopped. Reads never call connectService.
      if (!stopped) await read();
    }
  };
  const exportDiagnostics = async () => {
    if (exporting) return;
    setExporting(true);
    setExportNotice("");
    setExportError("");
    try {
      const result = await action("exportDiagnostics", {});
      setExportNotice(
        "canceled" in result
          ? { id: "settings.serviceStatusSettings.exportCanceled" }
          : {
              id: "settings.serviceStatusSettings.diagnosticsSavedToValue",
              values: { value0: result.path },
            },
      );
    } catch {
      setExportError({
        id: "settings.serviceStatusSettings.couldNotSaveDiagnosticsChooseAnotherLocation",
      });
    } finally {
      setExporting(false);
    }
  };
  return (
    <div
      className="settings-sections"
      aria-label={t("settings.serviceStatusSettings.backgroundServiceManagement")}
    >
      <SettingsSection
        title={t("settings.serviceStatusSettings.sharedBackgroundService")}
        action={
          <ActionButton
            pending={refreshing}
            disabled={busy || !connected}
            onClick={async () => {
              setRefreshing(true);
              try {
                await read();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            {t("settings.serviceStatusSettings.refreshServiceStatus")}
          </ActionButton>
        }
      >
        {backendStatus && <BackendServiceStatus {...backendStatus} />}
        <SettingsGroupCard>
          <SettingsRow
            label={t("settings.serviceStatusSettings.backgroundService")}
            description={
              connected
                ? readError
                  ? t("settings.serviceStatusSettings.theInterfaceIsConnectedWorkspaceStatusNeeds")
                  : status
                    ? t("settings.serviceStatusSettings.connectedSummary", {
                        value0: status.clients,
                        value1: status.activeCommands,
                      })
                    : t("settings.serviceStatusSettings.connected")
                : t("settings.serviceStatusSettings.disconnected")
            }
            control={
              <SettingsSwitch
                aria-label={t("settings.serviceStatusSettings.backgroundService")}
                checked={connected}
                disabled={busy || (connected && !!readError)}
                onCheckedChange={(enabled) => void run(enabled ? "connect" : "stopService")}
              />
            }
          />
          <SettingsRow
            control={null}
            label={t("settings.serviceStatusSettings.closeWindow")}
            description={t(
              "settings.serviceStatusSettings.hidesTheInterfaceWhileTheBackgroundService",
            )}
          />
          <SettingsRow
            label={t("settings.serviceStatusSettings.quitApplication")}
            description={t("settings.serviceStatusSettings.stopsAllBackgroundServicesForThisApp")}
            control={
              <ActionButton disabled={busy} onClick={() => void run("quitInterface")}>
                {t("settings.serviceStatusSettings.quitAReaLHarness")}
              </ActionButton>
            }
          />
          <SettingsRow
            control={null}
            label={t("settings.serviceStatusSettings.quitRequirements")}
            description={
              !connected
                ? runningState === "stopped"
                  ? t("settings.serviceStatusSettings.theBackgroundServiceIsConfirmedStopped")
                  : t(
                      "settings.serviceStatusSettings.disconnectedCheckWhetherTheBackgroundServiceIs",
                    )
                : status?.clients && status.clients > 1
                  ? t("settings.serviceStatusSettings.quitOtherInterfacesConnectedToTheSame")
                  : status?.canStop
                    ? t("settings.serviceStatusSettings.theCurrentCheckAllowsASafeStop")
                    : t("settings.serviceStatusSettings.blockingItemsAreListedBelowOpenThe")
            }
          />
          <SettingsRow
            label={t("settings.serviceStatusSettings.resourceCheckAndRecovery")}
            control={
              <ActionButton disabled={busy} onClick={() => void run("recoverResources")}>
                {t("settings.serviceStatusSettings.checkAndRecover")}
              </ActionButton>
            }
          />
        </SettingsGroupCard>
        <DelayedVisible active={busy || (reading && refreshing)}>
          <p role="status" className="settings-section-desc">
            {t("settings.serviceStatusSettings.processing")}
          </p>
        </DelayedVisible>
        {notice && <p role="status">{formatUiMessage(t, notice)}</p>}
        {readError && (
          <p role="alert" className="text-destructive">
            {formatUiMessage(t, readError)}
          </p>
        )}
        {actionError && (
          <p role="alert" className="text-destructive">
            {actionError}
          </p>
        )}
        {status?.providerUpdating && (
          <p role="status">{t("settings.serviceStatusSettings.modelConfigurationIsUpdating")}</p>
        )}
        {!!status?.starting && (
          <p role="status">
            {t("settings.serviceStatusSettings.starting", { count: status.starting })}
          </p>
        )}
      </SettingsSection>
      <SettingsSection title={t("settings.serviceStatusSettings.localDiagnostics")}>
        <SettingsGroupCard>
          <SettingsRow
            label={t("settings.serviceStatusSettings.diagnosticsArchive")}
            description={t(
              "settings.serviceStatusSettings.saveLocalConnectionAndProcessFailureRecords",
            )}
            control={
              <ActionButton
                pending={exporting}
                disabled={exporting}
                onClick={() => void exportDiagnostics()}
              >
                {t("settings.serviceStatusSettings.exportDiagnostics")}
              </ActionButton>
            }
          />
        </SettingsGroupCard>
        {exportNotice && <p role="status">{formatUiMessage(t, exportNotice)}</p>}
        {exportError && (
          <p role="alert" className="text-destructive">
            {formatUiMessage(t, exportError)}
          </p>
        )}
      </SettingsSection>
      {recovery?.projects.map((project) => (
        <SettingsSection
          key={`recovery-${project.projectId}`}
          title={project.root.split(/[\\/]/).filter(Boolean).at(-1)}
        >
          <SettingsGroupCard>
            <SettingsRow
              label={t("settings.serviceStatusSettings.previousBackgroundServiceReview")}
              description={project.message}
              control={
                <span className="text-foreground-subtle">
                  {project.state === "clean"
                    ? t("settings.serviceStatusSettings.cleanupConfirmed")
                    : project.state === "idle"
                      ? t("settings.serviceStatusSettings.safeToStop")
                      : t("settings.serviceStatusSettings.needsReview")}
                </span>
              }
            />
          </SettingsGroupCard>
        </SettingsSection>
      ))}
      {status?.projects
        .slice()
        .sort((a, b) => Number(b.started && !b.restartSafe) - Number(a.started && !a.restartSafe))
        .map((project) => (
          <SettingsSection
            key={project.projectId}
            title={project.root.split(/[\\/]/).filter(Boolean).at(-1)}
          >
            <div data-testid={`service-project-${project.projectId}`}>
              <SettingsGroupCard>
                <SettingsRow
                  label={
                    !project.started
                      ? t("settings.serviceStatusSettings.workspaceNotStarted")
                      : project.restartSafe
                        ? t("settings.serviceStatusSettings.workspaceResourceCheckPassed")
                        : t(
                            "settings.serviceStatusSettings.itemsPreventTheBackgroundServiceFromQuitting",
                          )
                  }
                  description={
                    !project.started
                      ? t("settings.serviceStatusSettings.readingStatusOnThisPageDoesNot")
                      : t("settings.serviceStatusSettings.workspaceActivity", {
                          value0: project.activeThreads?.length ?? 0,
                          value1: project.goalThreads?.length ?? 0,
                          value2: project.activeTasks ?? 0,
                        })
                  }
                  control={
                    <span className="text-foreground-subtle">
                      {t("settings.serviceStatusSettings.remainingResources", {
                        count: project.resources?.length ?? 0,
                      })}
                    </span>
                  }
                />
                {project.activeThreads?.map((turn) => (
                  <div key={turn.turnId} data-testid={`service-active-${turn.threadId}`}>
                    <SettingsRow
                      label={t("settings.serviceStatusSettings.running")}
                      description={t("settings.serviceStatusSettings.sessionValue", {
                        value0: turn.threadId,
                      })}
                      control={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !connected || !onOpen}
                          onClick={() => onOpen?.(project.projectId, turn.threadId)}
                        >
                          {t("settings.serviceStatusSettings.openConversation")}
                        </Button>
                      }
                    />
                  </div>
                ))}
                {(
                  project.goals ??
                  project.goalThreads?.map((threadId) => ({
                    threadId,
                    status: "active",
                    objective: t("settings.serviceStatusSettings.ongoingGoal"),
                  }))
                )?.map((goal) => (
                  <div key={goal.threadId} data-testid={`service-goal-${goal.threadId}`}>
                    <SettingsRow
                      label={goal.objective}
                      description={t("settings.serviceStatusSettings.ongoingGoalValue", {
                        value0:
                          {
                            active: t("settings.serviceStatusSettings.active"),
                            paused: t("settings.serviceStatusSettings.paused"),
                            budgetLimited: t("settings.serviceStatusSettings.budgetLimitReached"),
                            blocked: t("settings.serviceStatusSettings.blocked"),
                          }[goal.status] ?? goal.status,
                      })}
                      control={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !connected || !onOpen}
                          onClick={() => onOpen?.(project.projectId, goal.threadId, "编辑目标")}
                        >
                          {t("settings.serviceStatusSettings.viewGoal")}
                        </Button>
                      }
                    />
                  </div>
                ))}
                {project.tasks?.map((task) => (
                  <div key={task.id} data-testid={`service-task-${task.id}`}>
                    <SettingsRow
                      label={task.objective}
                      description={t("settings.serviceStatusSettings.taskSummary", {
                        kind: task.mode,
                        state: task.paused
                          ? "paused"
                          : task.running
                            ? "running"
                            : task.nextRunAt
                              ? "next"
                              : "idle",
                        date: task.nextRunAt
                          ? intl.formatDate(task.nextRunAt * 1000, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          : "",
                      })}
                      control={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !connected || !onTask}
                          onClick={() => onTask?.(project.projectId, task.id)}
                        >
                          {t("settings.serviceStatusSettings.viewTask")}
                        </Button>
                      }
                    />
                  </div>
                ))}
                {project.queues?.map((queue) => (
                  <SettingsRow
                    key={queue.threadId}
                    label={
                      queue.paused
                        ? t("settings.serviceStatusSettings.queuePaused")
                        : t("settings.serviceStatusSettings.queueReady")
                    }
                    description={t("settings.serviceStatusSettings.queueActivity", {
                      value0: queue.pending,
                      value1: queue.running,
                    })}
                    control={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !connected || !onOpen}
                        onClick={() => onOpen?.(project.projectId, queue.threadId, "队列")}
                      >
                        {t("settings.serviceStatusSettings.viewQueue")}
                      </Button>
                    }
                  />
                ))}
                {project.pendingRequests?.map((request, index) => (
                  <SettingsRow
                    key={index}
                    label={
                      request.awaitingResponse
                        ? t("settings.serviceStatusSettings.requestAwaitingAResponse")
                        : t("settings.serviceStatusSettings.operationResultNeedsConfirmation")
                    }
                    description={t(
                      "settings.serviceStatusSettings.itWillNotBeResentAutomaticallyCheck",
                    )}
                    control={
                      request.threadId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !connected || !onOpen}
                          onClick={() => onOpen?.(project.projectId, request.threadId!)}
                        >
                          {t("settings.serviceStatusSettings.openConversation")}
                        </Button>
                      ) : (
                        <span>{t("settings.serviceStatusSettings.projectOperation")}</span>
                      )
                    }
                  />
                ))}
                {project.resources?.map((resource) => (
                  <div key={resource.id} data-testid={`service-resource-${resource.id}`}>
                    <SettingsRow
                      label={
                        resource.executable || t("settings.serviceStatusSettings.managedProcess")
                      }
                      description={
                        resource.stale
                          ? t("settings.serviceStatusSettings.belongsToAnOlderRuntimeVerifyThe")
                          : t("settings.serviceStatusSettings.resourceCleanupNotConfirmed")
                      }
                      control={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !connected || !onOpen}
                          onClick={() => onOpen?.(project.projectId, resource.threadId, "进程")}
                        >
                          {t("settings.serviceStatusSettings.viewProcess")}
                        </Button>
                      }
                    />
                  </div>
                ))}
                {project.started && (
                  <SpaceReclamation
                    key={project.projectId}
                    projectId={project.projectId}
                    projectName={
                      project.root.split(/[\\/]/).filter(Boolean).at(-1) ||
                      t("settings.serviceStatusSettings.workspace")
                    }
                    action={action}
                    disabled={busy || !connected}
                    onChange={read}
                  />
                )}
              </SettingsGroupCard>
              {!!project.unresolvedTools && (
                <p role="status">
                  {t("settings.serviceStatusSettings.unresolvedTools", {
                    count: project.unresolvedTools,
                  })}
                </p>
              )}
              {!!project.compactions && (
                <p role="status">
                  {t("settings.serviceStatusSettings.compactions", { count: project.compactions })}
                </p>
              )}
              {!!project.workgroups && (
                <p role="status">
                  {t("settings.serviceStatusSettings.workgroups", { count: project.workgroups })}
                </p>
              )}
            </div>
          </SettingsSection>
        ))}
      {status && !status.projects.length && (
        <p className="settings-section-desc">
          {t("settings.serviceStatusSettings.noWorkspacesAddedYet")}
        </p>
      )}
    </div>
  );
}
