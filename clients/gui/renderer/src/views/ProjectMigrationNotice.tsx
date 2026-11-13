import { FeedbackNotice } from "../FeedbackNotice.js";
import { projectUserState } from "../state/userStates.js";
import { useI18n } from "../i18n/IntlProvider.js";

export function ProjectMigrationNotice({
  project,
}: {
  project: Parameters<typeof projectUserState>[0];
}) {
  const { t } = useI18n();
  if (projectUserState(project).kind !== "needsUpgrade") return null;
  return (
    <FeedbackNotice
      tone="warning"
      message={t("common.navigation.migrationPending")}
      detail={t("common.navigation.migrationRecovery")}
    />
  );
}
