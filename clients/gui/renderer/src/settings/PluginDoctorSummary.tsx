import { useState } from "react";
import type { ManagementResponseMap } from "../services.js";
import type { PluginCommand } from "./pluginTypes.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { Button } from "../components/ui/button.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { Feedback } from "./common.js";
import { pluginStateMessages } from "./PluginOverview.js";
export function PluginDoctorSummary({
  command,
  projectId,
}: {
  command: PluginCommand;
  projectId?: string;
}) {
  const { t, intl } = useI18n();
  const [report, setReport] = useState<ManagementResponseMap["pluginStoreDoctor"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const read = async () => {
    setBusy(true);
    setError("");
    try {
      setReport(
        await command({ operation: "pluginStoreDoctor", ...(projectId ? { projectId } : {}) }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("settings.pluginCenter.pluginOperationFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDisclosure title={t("settings.pluginCenter.pluginDoctor")}>
      <p>{t("settings.pluginCenter.doctorStaticBoundary")}</p>
      <Button variant="outline" disabled={busy} onClick={() => void read()}>
        {t("settings.pluginCenter.readDoctorReport")}
      </Button>
      <Feedback error={error || report?.errors.join("\n")} />
      {report && (
        <>
          <p>
            {t("settings.pluginCenter.snapshotScope", {
              scope:
                report.scope.kind === "user"
                  ? t("settings.pluginCenter.user")
                  : report.scope.workspace,
              revision: report.revision,
              time: intl.formatDate(report.observedAt, { dateStyle: "medium", timeStyle: "short" }),
            })}
          </p>
          <ul>
            {report.data.map((row) => (
              <li key={row.id}>
                <strong>{row.id}</strong>
                {row.state in pluginStateMessages && (
                  <p>{t(pluginStateMessages[row.state as keyof typeof pluginStateMessages])}</p>
                )}
                <p>{row.availableComponents.join(", ")}</p>
                {row.developmentStatus && <p>{row.developmentStatus}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </SettingsDisclosure>
  );
}
