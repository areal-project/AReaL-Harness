import type { ComponentProps, RefObject } from "react";
import type { Preview } from "./Preview.js";
import type { BrowserWorkspaceRequest } from "./app-shell/useBrowserWorkspace.js";
import type { Data } from "./services.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { Button } from "./components/ui/button.js";
import { BrowserVerificationCard } from "./BrowserVerificationCard.js";
type WithoutPage<Request> = Request extends unknown ? Omit<Request, "pageId"> : never;
export function BrowserDetails({
  state,
  annotating,
  styleTrial,
  annotationBusy,
  styleBusy,
  keyboardCapture,
  styleControl,
  startStyleTrial,
  request,
  thread,
  projectId,
  action,
  onReview,
  onTool,
  onClose,
}: Pick<
  ComponentProps<typeof Preview>,
  "state" | "thread" | "projectId" | "action" | "onReview" | "onTool"
> & {
  annotating: unknown;
  styleTrial: { cleared?: boolean } | null;
  annotationBusy: boolean;
  styleBusy: boolean;
  keyboardCapture: unknown;
  styleControl: RefObject<HTMLButtonElement | null>;
  startStyleTrial: (keyboard: boolean) => Promise<void>;
  request: (request: WithoutPage<BrowserWorkspaceRequest>) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="browser-details" aria-label={t("browser.details.label")}>
      <div className="preview-viewport-toolbar">
        <span>{t("settings.browserData.sharedShort")}</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => onClose()}>
          {t("browser.details.close")}
        </Button>
      </div>
      {state.url && (
        <div
          className="preview-viewport-toolbar"
          role="group"
          aria-label={t("browser.details.handoff")}
        >
          {state.browser?.control === "human" ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={!!state.browser?.downloadIntentExpiresAt || !!annotating || !!styleTrial}
                onClick={() => void request({ operation: "allowNextDownload", userIntent: true })}
              >
                {t("browser.details.allowDownload")}
              </Button>
              {state.browser?.downloadIntentExpiresAt && (
                <>
                  <span role="status">{t("browser.details.downloadHint")}</span>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void request({ operation: "cancelFileHandoff" })}
                  >
                    {t("browser.details.cancelPermission")}
                  </Button>
                </>
              )}
              <span>{t("browser.details.uploadHint")}</span>
            </>
          ) : (
            <span>{t("browser.details.directHint")}</span>
          )}
        </div>
      )}
      {(state.workspace?.fileReceipts ?? []).length > 0 && (
        <div
          className="preview-viewport-toolbar preview-file-status"
          role="list"
          aria-label={t("browser.details.downloads")}
        >
          {(state.workspace.fileReceipts as Data[]).map((receipt: Data) => (
            <div role="listitem" key={receipt.id}>
              {receipt.name || t("browser.details.unnamed")} · {t("browser.details.page")}{" "}
              {receipt.pageOrigin || t("browser.details.unknown")} ·{" "}
              {t("browser.details.initiator")}{" "}
              {receipt.initiator === "unknown" ? t("browser.details.unknown") : receipt.initiator}
              {" · "}
              {receipt.source || t("browser.details.unknownSource")}
              {" · "}
              {receipt.sizeBytes == null
                ? t("browser.details.unknownSize")
                : `${receipt.sizeBytes} B`}
              {" · "}
              {(
                {
                  choosing: t("browser.details.choosing"),
                  downloading: t("browser.details.downloading"),
                  completed: t("browser.details.completed"),
                  cancelled: t("browser.details.cancelled"),
                  interrupted: t("browser.details.interrupted"),
                  unknown: t("browser.details.reconcile"),
                } as Record<string, string>
              )[receipt.status] ?? t("browser.details.unknownStatus")}
              {receipt.target ? t("browser.details.savedAs", { path: receipt.target }) : ""}
              {["choosing", "downloading", "interrupted"].includes(receipt.status) &&
                receipt.pageId === state.browser?.pageId &&
                state.browser?.control === "human" && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      void request({
                        operation: "cancelDownload",
                        downloadId: receipt.id,
                        userIntent: true,
                      })
                    }
                  >
                    {t("browser.details.cancelDownload")}
                  </Button>
                )}
            </div>
          ))}
        </div>
      )}
      {state.url && state.browser?.control === "human" && (
        <div
          className="preview-viewport-toolbar"
          role="group"
          aria-label={t("browser.details.frameGrant")}
        >
          {state.browser.frameOriginGrant ? (
            <>
              <span role="status">
                {t("browser.details.frame")} {state.browser.frameOriginGrant.origin}{" "}
                {t("common.browser.manualFrame")}
              </span>
              {state.browser.frameOriginGrant.status === "pending" && (
                <Button
                  type="button"
                  size="sm"
                  disabled={!!annotating || !!styleTrial}
                  onClick={() => void request({ operation: "reloadFrameOrigin", userIntent: true })}
                >
                  {t("browser.details.reloadFrame")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                disabled={!!annotating || !!styleTrial}
                onClick={() => void request({ operation: "revokeFrameOrigin", userIntent: true })}
              >
                {t("browser.details.revokeFrame")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!!annotating || !!styleTrial || annotationBusy}
              onClick={() => void request({ operation: "authorizeFrameOrigin", userIntent: true })}
            >
              {t("browser.details.authorizeFrame")}
            </Button>
          )}
        </div>
      )}
      {state.url && (
        <div
          className="preview-viewport-toolbar"
          role="group"
          aria-label={t("browser.details.annotations")}
        >
          <Button
            ref={styleControl}
            type="button"
            size="sm"
            disabled={
              annotationBusy ||
              styleBusy ||
              !!keyboardCapture ||
              !!styleTrial ||
              !!annotating ||
              state.browser?.control === "transferring"
            }
            onClick={(event) => void startStyleTrial(event.detail === 0)}
          >
            {t("browser.details.styleTrial")}
          </Button>
          <span>{t("browser.details.focusHint")}</span>
          <span
            role="status"
            aria-hidden={!annotationBusy || !!annotating}
            style={{ visibility: annotationBusy && !annotating ? "visible" : "hidden" }}
          >
            {t("browser.details.selectHint")}
          </span>
        </div>
      )}
      {thread && (
        <BrowserVerificationCard
          thread={thread}
          projectId={projectId}
          action={action}
          onReview={onReview}
          onTool={onTool}
          trialActive={(!!styleTrial && !styleTrial.cleared) || !!state.browser?.trialActive}
        />
      )}
    </div>
  );
}
