import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { errorText } from "../errors/errorCopy.js";
import { useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { isIndependentCreation, recoveredOutcome } from "../recoveryPresentation.js";
import type { Action, Data } from "../services.js";

export function CreationRecoverySettings({
  projects,
  connected,
  action,
}: {
  projects: Data[];
  connected: boolean;
  action: Action;
}) {
  const { t } = useI18n();
  const records = projects.flatMap((project) =>
    (project.pending ?? [])
      .filter((entry: Data) => !entry.awaitingResponse && isIndependentCreation(entry, []))
      .map((entry: Data) => ({ project, entry })),
  );
  if (!records.length) return null;
  return (
    <SettingsSection title={t("recovery.creationRecords")}>
      <SettingsGroupCard>
        {records.map(({ project, entry }) => (
          <CreationRecord
            key={`${project.id}:${entry.params.requestId}`}
            project={project}
            entry={entry}
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
  entry,
  connected,
  action,
}: {
  project: Data;
  entry: Data;
  connected: boolean;
  action: Action;
}) {
  const { t } = useI18n();
  const checking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const requestId = entry.params.requestId;
  const check = async () => {
    if (checking.current || !connected) return;
    checking.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await action("reconcile", { projectId: project.id, requestId });
      const outcome = recoveredOutcome(result ?? {}, requestId, "", entry.operation);
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
      label={project.root.split(/[\\/]/).filter(Boolean).at(-1) || project.id}
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
