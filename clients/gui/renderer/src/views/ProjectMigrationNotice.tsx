import type { ShellProject } from "@areal/client";
import { FeedbackNotice } from "../FeedbackNotice.js";
import { useI18n } from "../i18n/IntlProvider.js";

export function ProjectMigrationNotice({ hostState }: { hostState?: ShellProject["state"] }) {
  const { t } = useI18n();
  if (hostState !== "legacyPending") return null;
  return (
    <FeedbackNotice
      tone="warning"
      message={t("common.navigation.migrationPending")}
      detail={t("common.navigation.migrationRecovery")}
    />
  );
}
