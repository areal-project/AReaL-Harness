import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { errorText } from "../errors/errorCopy.js";
import { useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { recoveredOutcome } from "../recoveryPresentation.js";
import type { Action, CommandResponse } from "../services.js";

type Project = CommandResponse<"serviceStatus">["projects"][number];

export function CreationRecoverySettings({
  projects,
  connected,
  action,
}: {
  projects: Project[];
  connected: boolean;
  action: Action;
}) {
  const { t } = useI18n();
  const records = projects.flatMap((project) =>
    (project.pendingRequests ?? []).flatMap(({ creationRequestId, awaitingResponse }) =>
      creationRequestId && !awaitingResponse ? [{ project, requestId: creationRequestId }] : [],
    ),
  );
  if (!records.length) return null;
  return (
    <SettingsSection title={t("recovery.creationRecords")}>
      <SettingsGroupCard>
        {records.map(({ project, requestId }) => (
          <CreationRecord
            key={`${project.projectId}:${requestId}`}
            project={project}
            requestId={requestId}
            connected={connected}
            action={action}
          />
        ))}
      </SettingsGroupCard>
    </SettingsSection>
  );
}

function CreationRecord({
  project,
  requestId,
  connected,
  action,
}: {
  project: Project;
  requestId: string;
  connected: boolean;
  action: Action;
}) {
  const { t } = useI18n();
  const checking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const check = async () => {
    if (checking.current || !connected) return;
    checking.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await action("reconcile", {
        projectId: project.projectId,
        executionProjectId: project.projectId,
        requestId,
      });
      const outcome = recoveredOutcome(result, requestId, "", {
        requestId,
        method: "areal/thread/start",
        target: { kind: "project" },
      });
      setMessage(
        t(
          outcome?.status === "completed"
            ? "settings.pluginCenter.projectOperationConfirmedComplete"
            : outcome?.status === "failed"
              ? "settings.pluginCenter.projectOperationConfirmedFailed"
              : "settings.pluginCenter.projectOperationStillUnconfirmed",
        ),
      );
    } catch (error) {
      setMessage(errorText(t, error));
    } finally {
      checking.current = false;
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      label={project.root.split(/[\\/]/).filter(Boolean).at(-1) || project.projectId}
      description={t("recovery.creationRecordDescription")}
      detail={
        <>
          <p className="break-all">{t("recovery.requestId", { id: requestId })}</p>
          {message && <p role="status">{message}</p>}
        </>
      }
      control={
        <Button
          variant="outline"
          size="sm"
          disabled={!connected || busy}
          onClick={() => void check()}
        >
          {t(busy ? "settings.pluginCenter.checkingProjectOperation" : "recovery.checkOriginal")}
        </Button>
      }
    />
  );
}
