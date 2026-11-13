import { useSyncExternalStore } from "react";
import { Button } from "@areal/ui";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { useI18n } from "./i18n/IntlProvider.js";
import {
  getBrowserHostAuthStatus,
  resumeBrowserHostAuth,
  subscribeBrowserHostAuth,
} from "./browser-host-bootstrap.js";

export function BrowserHostAuthStatus() {
  const state = useSyncExternalStore(subscribeBrowserHostAuth, getBrowserHostAuthStatus);
  const { t } = useI18n();
  if (state.state === "idle" || state.state === "authenticated") return null;
  if (state.state === "connecting")
    return <output aria-live="polite">{t("workspace.connecting")}</output>;
  return (
    <section className="m-4 space-y-3" data-testid="browser-host-auth-status" aria-live="polite">
      <FeedbackNotice
        transient={false}
        tone={state.state === "pairing" ? "info" : "error"}
        message={t(
          state.state === "pairing"
            ? "browserHost.pairingTitle"
            : state.reason === "expired"
              ? "browserHost.expired"
              : "browserHost.unavailable",
        )}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (state.state === "error" && state.reason === "unavailable")
                window.location.reload();
              else resumeBrowserHostAuth();
            }}
          >
            {t(state.state === "pairing" ? "browserHost.checkApproval" : "browserHost.retry")}
          </Button>
        }
      />
      {state.state === "pairing" && (
        <>
          <p className="text-ui-caption text-foreground-subtle">{t("browserHost.pairingHelp")}</p>
          <pre className="whitespace-pre-wrap break-all select-text">
            {t("browserHost.approveCommand", { requestId: state.requestId })}
          </pre>
          <p className="text-ui-caption text-foreground-subtle">{t("browserHost.fingerprint")}</p>
          <code className="block break-all select-text">{state.fingerprint}</code>
        </>
      )}
    </section>
  );
}
