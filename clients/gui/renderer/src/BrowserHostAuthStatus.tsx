import { useState, useSyncExternalStore } from "react";
import { Check, Copy } from "lucide-react";
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
  const [copied, setCopied] = useState(false);
  if (state.state === "idle" || state.state === "authenticated") return null;
  if (state.state === "connecting")
    return <output aria-live="polite">{t("workspace.connecting")}</output>;
  const approveCommand =
    state.state === "pairing"
      ? t("browserHost.approveCommand", { requestId: state.requestId })
      : "";
  const formattedFingerprint =
    state.state === "pairing"
      ? (state.fingerprint.match(/.{1,8}/g)?.join(" ") ?? state.fingerprint)
      : "";
  const copyApproveCommand = () => {
    if (!approveCommand) return;
    void navigator.clipboard?.writeText(approveCommand).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6"
      data-testid="browser-host-auth-status"
      aria-live="polite"
    >
      <section className="w-full max-w-xl space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
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
          <div className="space-y-3">
            <p className="text-ui-caption text-foreground-subtle">{t("browserHost.pairingHelp")}</p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
              <pre className="min-w-0 flex-1 font-mono text-ui-sm whitespace-pre-wrap break-all select-text">
                {approveCommand}
              </pre>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={copied ? t("content.copied") : t("terminal.contextMenu.copy")}
                title={copied ? t("content.copied") : t("terminal.contextMenu.copy")}
                onClick={copyApproveCommand}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
            <div className="space-y-1">
              <p className="text-ui-caption text-foreground-subtle">
                {t("browserHost.fingerprint")}
              </p>
              <code className="block rounded-lg border border-border bg-muted px-3 py-2 font-mono text-ui-caption text-foreground-subtle select-text">
                {formattedFingerprint}
              </code>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
