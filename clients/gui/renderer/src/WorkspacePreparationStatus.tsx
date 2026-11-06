import { useState } from "react";
import { Button } from "./components/ui/button.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { FeedbackNotice } from "./FeedbackNotice.js";

export type WorkspacePreparationState =
  | { kind: "preparing" }
  | { kind: "unavailable"; detail: string }
  | { kind: "ready" };

export function WorkspacePreparationStatus({
  state,
  scope = "connection",
  onRetry,
}: {
  state: WorkspacePreparationState;
  scope?: "connection" | "workspace";
  onRetry?: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  if (state.kind === "ready") return null;
  const label =
    state.kind === "preparing"
      ? t(scope === "connection" ? "workspace.connecting" : "workspace.preparing")
      : t(
          scope === "connection"
            ? "workspace.connectionUnavailable"
            : "workspace.preparationUnavailable",
        );
  if (state.kind === "preparing")
    return (
      <span role="status" data-testid="workspace-preparation-status">
        {label}
      </span>
    );
  return (
    <FeedbackNotice
      tone="error"
      message={label}
      detail={`${t("workspace.draftEditable")}\n\n${state.detail}`}
      actions={
        onRetry && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void onRetry()
                .catch(() => {})
                .finally(() => setRetrying(false));
            }}
          >
            {t(scope === "workspace" ? "recovery.retryPrepare" : "recovery.reconnectProject")}
          </Button>
        )
      }
    />
  );
}
