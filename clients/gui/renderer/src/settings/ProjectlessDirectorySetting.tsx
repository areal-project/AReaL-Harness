import { TitleTooltip } from "@areal/ui";
import { SettingsRow } from "@areal/ui/compositions";
import { useI18n, UiMessageError, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { useRef, useState } from "react";
import type { PlatformServices } from "../services.js";
import { Button } from "../components/ui/button.js";

export function ProjectlessDirectorySetting({
  directory,
  choose,
  connected,
}: {
  directory?: string;
  choose?: PlatformServices["chooseProjectlessDirectory"];
  connected: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | UiMessage>("");
  const pending = useRef(false);
  const change = async () => {
    if (!choose || !connected || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await choose();
    } catch (cause) {
      setError(
        cause instanceof UiMessageError
          ? cause.descriptor
          : cause instanceof Error
            ? cause.message
            : { id: "settings.projectlessDirectorySetting.directorySettingWasNotSaved" },
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsRow
        label={t("settings.projectlessDirectorySetting.folderForTasksOutsideProjects")}
        description={t("settings.projectlessDirectorySetting.newTasksOutsideProjectsAreSavedIn")}
        control={
          <div className="flex min-w-0 items-center gap-inline">
            <TitleTooltip title={directory}>
              <span className="max-w-[calc(var(--reading-width)*5/16)] truncate text-ui-sm/(--line-height-ui-sm)">
                {directory ?? t("settings.projectlessDirectorySetting.disconnected")}
              </span>
            </TitleTooltip>
            <Button
              size="sm"
              variant="outline"
              aria-label={t(
                "settings.projectlessDirectorySetting.changeFolderForTasksOutsideProjects",
              )}
              disabled={!connected || !choose || busy}
              onClick={() => void change()}
            >
              {t("settings.projectlessDirectorySetting.change")}
            </Button>
          </div>
        }
      />
      {error && (
        <p role="alert" className="px-4 py-2 text-destructive">
          {formatUiMessage(t, error)}
        </p>
      )}
    </>
  );
}
