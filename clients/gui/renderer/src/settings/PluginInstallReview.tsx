import type { RefObject } from "react";
import type { Data } from "../services.js";
import type { PluginDetail, PluginPreview } from "./pluginTypes.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { Button } from "../components/ui/button.js";
import { Feedback } from "./common.js";
import { ResourceScope } from "./ScopedSkillsSettings.js";

export function PluginInstallReview({
  detail,
  preview,
  previewCurrent,
  sourceLabel,
  sourceError,
  sourceMessage,
  scope,
  setScope,
  project,
  disabled,
  busy,
  panelRef,
  onInstall,
  onResolve,
  onCancel,
}: {
  detail: PluginDetail;
  preview: PluginPreview | null;
  previewCurrent: boolean;
  sourceLabel: string;
  sourceError: string;
  sourceMessage: string;
  scope: "user" | "project";
  setScope: (scope: "user" | "project") => void;
  project?: Data;
  disabled: boolean;
  busy: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onInstall: () => void;
  onResolve: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="plugin-status-panel"
      aria-label={t("settings.pluginCenter.sourceResolutionAndPreview")}
    >
      <h2>
        {detail.installed
          ? t("settings.pluginCenter.reviewNewInstallationSnapshot")
          : t("settings.pluginCenter.notInstalled")}
      </h2>
      <p className="plugin-status-description">
        {t("settings.pluginCenter.reviewTheSourceThenChooseAnInstallation")}
      </p>
      <div className="plugin-install-review">
        <Feedback error={sourceError} message={sourceMessage} />
        {preview?.id === detail.id && (
          <dl className="plugin-metadata">
            <dt>{t("settings.pluginCenter.source2")}</dt>
            <dd>{sourceLabel}</dd>
            {(preview.packageVersion || preview.version) && (
              <>
                <dt>{t("settings.pluginCenter.packageVersion")}</dt>
                <dd>{preview.packageVersion || preview.version}</dd>
              </>
            )}
            <dt>{t("settings.pluginCenter.contentDigest")}</dt>
            <dd>
              <code>{preview.sourceDigest}</code>
            </dd>
            {preview.admissionDigest && (
              <>
                <dt>{t("settings.pluginCenter.definitionReviewDigest")}</dt>
                <dd>
                  <code>{preview.admissionDigest}</code>
                </dd>
              </>
            )}
            {preview.resolvedCommit && (
              <>
                <dt>{t("settings.pluginCenter.pinnedCommit")}</dt>
                <dd>
                  <code>{preview.resolvedCommit}</code>
                </dd>
              </>
            )}
            {preview.integrity && (
              <>
                <dt>{t("settings.pluginCenter.integrity")}</dt>
                <dd>
                  <code>{preview.integrity}</code>
                </dd>
              </>
            )}
          </dl>
        )}
        {previewCurrent && (
          <>
            <div className="plugin-scope-field">
              <span>{t("settings.pluginCenter.installationScope")}</span>
              <ResourceScope
                value={scope}
                onChange={(value) => {
                  if (value === "user" || value === "project") setScope(value);
                }}
                project={project}
                disabled={disabled}
              />
            </div>
            <p className="plugin-status-note">
              {scope === "user"
                ? t("settings.pluginCenter.availableToProjectsUnderTheSameUser")
                : t("settings.pluginCenter.saveWithinTheCurrentProjectScope")}
            </p>
            <p className="plugin-status-note">{t("settings.pluginCenter.installTrustBoundary")}</p>
          </>
        )}
        {preview && !previewCurrent && (
          <p role="status">{t("settings.pluginCenter.theCatalogChangedResolveTheSourceAgain")}</p>
        )}
        <div className="plugin-service-actions">
          {previewCurrent ? (
            <Button disabled={disabled} onClick={onInstall}>
              {detail.installed
                ? t("settings.pluginCenter.installReviewedSnapshot")
                : t("settings.pluginCenter.installForValue", {
                    value0:
                      scope === "user"
                        ? t("settings.pluginCenter.user")
                        : t("settings.pluginCenter.currentProject"),
                  })}
            </Button>
          ) : (
            <Button disabled={disabled} onClick={onResolve}>
              {t("settings.pluginCenter.resolveSourceAgain")}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t("settings.pluginCenter.cancelInstallation")}
          </Button>
        </div>
      </div>
    </section>
  );
}
