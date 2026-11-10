import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { errorText } from "../errors/errorCopy.js";
import { useI18n, formatUiMessage, UiMessageError, type UiMessage } from "../i18n/IntlProvider.js";
import { useRef, useState } from "react";
import { ActionButton } from "../components/ui/action-button.js";

import { SettingsDialog } from "./common.js";
import type { Action } from "../services.js";

type Operation = "serverDrain" | "serverGc";
export function SpaceReclamation({
  projectId,
  projectName,
  action,
  disabled,
  onChange,
}: {
  projectId: string;
  projectName: string;
  action: Action;
  disabled: boolean;
  onChange: () => Promise<void>;
}) {
  const { t } = useI18n();
  const prefix = `areal-gui:space-maintenance:${projectId}:`;
  const hasUnconfirmed = () => Object.keys(localStorage).some((key) => key.startsWith(prefix));
  const [unconfirmed, setUnconfirmed] = useState(hasUnconfirmed);
  const [notice, setNotice] = useState<string | UiMessage>("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | UiMessage>(""),
    [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const run = async (operation: Operation) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const key = `${prefix}${crypto.randomUUID()}`;
    try {
      // Retain uncertainty if the Renderer goes away after dispatch. This is UI
      // recovery state, never an execution journal or a reason to replay.
      // Each invocation owns its marker. A later successful operation cannot
      // erase an earlier unknown result, even for the same maintenance action.
      localStorage.setItem(key, operation);
      if (operation === "serverDrain") {
        const result = await action("manage", { projectId, operation });
        if (result.draining !== true || result.restartSafe !== true)
          throw new UiMessageError({
            id: "settings.spaceReclamation.coreHasNotFinishedDrainingCheckExecution",
          });
        setNotice({ id: "settings.spaceReclamation.newWorkIsNoLongerAccepted" });
      } else {
        const result = await action("manage", { projectId, operation });
        setNotice({
          id: "settings.spaceReclamation.reclaimedStorage",
          values: {
            reclaimed: result.reclaimedBytes,
            attachments: result.deletedBlobs,
            retained: result.retainedBytes,
          },
        });
      }
      localStorage.removeItem(key);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      setError(errorText(t, failure));
      if (!failure.submissionUnknown) localStorage.removeItem(key);
      else
        setNotice({ id: "settings.spaceReclamation.theMaintenanceResultNeedsVerificationItWill" });
    } finally {
      setUnconfirmed(hasUnconfirmed());
      locked.current = false;
      setBusy(false);
      await onChange();
    }
  };
  const feedback = (
    <>
      {busy && (
        <p role="status" className="px-4 pb-3 text-ui-sm">
          {t("settings.spaceReclamation.maintainingStorage")}
        </p>
      )}
      {notice && (
        <p role="status" className="px-4 pb-3 text-ui-sm">
          {formatUiMessage(t, notice)}
        </p>
      )}
      {unconfirmed && !busy && (
        <p role="status" className="px-4 pb-3 text-ui-sm">
          {t("settings.spaceReclamation.thePreviousMaintenanceResultNeedsVerificationIt")}
        </p>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-ui-sm text-destructive">
          {formatUiMessage(t, error)}
        </p>
      )}
    </>
  );
  return (
    <div aria-label={t("settings.spaceReclamation.reclaimStorage")}>
      <SettingsRow
        label={t("settings.spaceReclamation.reclaimStorage")}
        description={t("settings.spaceReclamation.reclaimUnusedAttachmentsAndKeepChatHistory")}
        control={
          <ActionButton disabled={disabled || busy} onClick={() => setOpen(true)}>
            {t("settings.spaceReclamation.manageStorage")}
          </ActionButton>
        }
      />
      {!open && feedback}
      {open && (
        <SettingsDialog
          title={t("settings.spaceReclamation.manageStorageValue", { value0: projectName })}
          description={t("settings.spaceReclamation.stopTheBackgroundServiceAndReconnectAfter")}
          busy={busy}
          onClose={() => setOpen(false)}
        >
          <SettingsSection title={t("settings.spaceReclamation.acceptingWork")}>
            <SettingsGroupCard>
              <SettingsRow
                label={t("settings.spaceReclamation.acceptNewWork")}
                description={t("settings.spaceReclamation.stoppingEntersMaintenanceMode")}
                control={
                  <ActionButton disabled={disabled || busy} onClick={() => void run("serverDrain")}>
                    {t("settings.spaceReclamation.stopAcceptingWork")}
                  </ActionButton>
                }
              />
            </SettingsGroupCard>
          </SettingsSection>
          <SettingsSection title={t("settings.spaceReclamation.attachments")}>
            <SettingsGroupCard>
              <SettingsRow
                label={t("settings.spaceReclamation.unreferencedAttachments")}
                description={t("settings.spaceReclamation.reclaimAfterStoppingNewWorkChatHistory")}
                control={
                  <ActionButton disabled={disabled || busy} onClick={() => void run("serverGc")}>
                    {t("settings.spaceReclamation.reclaimStorage2")}
                  </ActionButton>
                }
              />
            </SettingsGroupCard>
          </SettingsSection>
          {feedback}
        </SettingsDialog>
      )}
    </div>
  );
}
