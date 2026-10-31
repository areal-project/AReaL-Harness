import { useEffect, useState } from "react";
import type { ManagementRequestMap } from "@areal/workbench/desktop-contract/management";
import type { PluginDetail, PluginMutate, PluginCommand } from "./pluginTypes.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@areal/ui/compositions";
import { Feedback } from "./common.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";

type PublicValue = ManagementRequestMap["pluginUserConfigSave"]["values"][string];
export function PluginConfiguration({
  detail,
  mutate,
  disabled,
  active,
  command,
  projectId,
}: {
  command: PluginCommand;
  projectId?: string;
  detail: PluginDetail;
  mutate: PluginMutate;
  disabled: boolean;
  active: boolean;
}) {
  const { t } = useI18n();
  const fields = detail.userConfiguration?.fields ?? {};
  const [reloadMessage, setReloadMessage] = useState("");
  const [reloadBusy, setReloadBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string | boolean | number>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [changed, setChanged] = useState<Set<string>>(() => new Set());
  const [clearKeys, setClearKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setDrafts(
      Object.fromEntries(
        Object.entries(fields)
          .filter(([, field]) => !field.definition.sensitive)
          .map(([key, field]) => [
            key,
            field.value ??
              field.definition.default ??
              (field.definition.type === "boolean" ? false : ""),
          ]),
      ),
    );
    setSecrets({});
    setChanged(new Set());
    setClearKeys(new Set());
  }, [detail.id, detail.installedDigest, detail.userConfiguration?.revision]);
  useEffect(() => {
    if (!active) setSecrets({});
  }, [active]);
  if (!detail.installedDigest) return null;
  const submit = async () => {
    const values: Record<string, PublicValue> = {};
    for (const key of changed) {
      if (clearKeys.has(key)) continue;
      const definition = fields[key].definition;
      const value = drafts[key];
      if (definition.type === "boolean") values[key] = { kind: "boolean", value: value === true };
      else if (definition.type === "number") values[key] = { kind: "number", value: Number(value) };
      else values[key] = { kind: "string", value: String(value ?? "") };
    }
    const transientSecrets = Object.fromEntries(
      Object.entries(secrets).filter(([key, value]) => value && !clearKeys.has(key)),
    );
    setSecrets({});
    await mutate({
      operation: "pluginUserConfigSave",
      id: detail.id,
      expectedRevision: detail.revision,
      expectedDigest: detail.installedDigest!,
      values,
      secrets: transientSecrets,
      clearKeys: [...clearKeys],
    });
  };
  return (
    <section className="plugin-detail-resources" data-plugin-configuration>
      {Object.keys(fields).length > 0 && (
        <>
          <h3>{t("settings.pluginCenter.userConfiguration")}</h3>
          <p>{t("settings.pluginCenter.secretConfigurationBoundary")}</p>
          {Object.values(fields).some(
            (field) => field.definition.sensitive && field.configured,
          ) && (
            <>
              <p>{t("settings.pluginCenter.sharedCredentialReloadRequired")}</p>
              <Button
                variant="outline"
                type="button"
                disabled={disabled || reloadBusy || !projectId}
                onClick={async () => {
                  if (!projectId) return;
                  setReloadBusy(true);
                  setReloadMessage("");
                  try {
                    await command({ operation: "pluginCredentialsReload", projectId });
                    setReloadMessage(t("settings.pluginCenter.credentialsReloaded"));
                    window.dispatchEvent(new Event("areal-plugins-changed"));
                  } catch (cause) {
                    setReloadMessage(
                      cause instanceof Error
                        ? cause.message
                        : t("settings.pluginCenter.pluginOperationFailed"),
                    );
                  } finally {
                    setReloadBusy(false);
                  }
                }}
              >
                {t("settings.pluginCenter.reloadProjectCredentials")}
              </Button>
              <Feedback message={reloadMessage} />
            </>
          )}

          {!!detail.userConfiguration?.missingRequired.length && (
            <p role="status">
              {t("settings.pluginCenter.missingConfiguration", {
                fields: detail.userConfiguration.missingRequired.join(", "),
              })}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <SettingsGroupCard>
              {Object.entries(fields).map(([key, field]) => {
                const definition = field.definition;
                return (
                  <SettingsRow
                    key={key}
                    label={
                      <label htmlFor={`plugin-config-${key}`}>
                        {definition.title || key}
                        {definition.required ? " *" : ""}
                      </label>
                    }
                    description={definition.description || undefined}
                    controlLayout="wide"
                    control={
                      definition.type === "boolean" ? (
                        <Switch
                          id={`plugin-config-${key}`}
                          checked={drafts[key] === true}
                          disabled={disabled || clearKeys.has(key)}
                          onCheckedChange={(value) => {
                            setDrafts((previous) => ({ ...previous, [key]: value }));
                            setChanged((previous) => new Set([...previous, key]));
                          }}
                        />
                      ) : (
                        <Input
                          id={`plugin-config-${key}`}
                          type={
                            definition.sensitive
                              ? "password"
                              : definition.type === "number"
                                ? "number"
                                : "text"
                          }
                          autoComplete={definition.sensitive ? "new-password" : "off"}
                          step={definition.type === "number" ? "any" : undefined}
                          required={
                            (definition.required && !field.configured && !clearKeys.has(key)) ||
                            (definition.type === "number" &&
                              changed.has(key) &&
                              !clearKeys.has(key))
                          }
                          disabled={disabled || clearKeys.has(key)}
                          value={
                            definition.sensitive ? (secrets[key] ?? "") : String(drafts[key] ?? "")
                          }
                          placeholder={
                            definition.sensitive && field.configured
                              ? t("settings.pluginCenter.secretAlreadyConfigured")
                              : undefined
                          }
                          onChange={(event) => {
                            const value = event.target.value;
                            if (definition.sensitive)
                              setSecrets((previous) => ({ ...previous, [key]: value }));
                            else {
                              setDrafts((previous) => ({ ...previous, [key]: value }));
                              setChanged((previous) => new Set([...previous, key]));
                            }
                          }}
                        />
                      )
                    }
                    detail={
                      field.configured ? (
                        <Button
                          variant="link"
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            setClearKeys((previous) => {
                              const next = new Set(previous);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          {t(
                            clearKeys.has(key)
                              ? "settings.pluginCenter.undoClearConfiguration"
                              : "settings.pluginCenter.clearSavedConfiguration",
                          )}
                        </Button>
                      ) : undefined
                    }
                  />
                );
              })}
            </SettingsGroupCard>
            <Button
              type="submit"
              disabled={
                disabled ||
                (!changed.size && !clearKeys.size && !Object.values(secrets).some(Boolean))
              }
            >
              {t("settings.pluginCenter.saveConfiguration")}
            </Button>
          </form>
        </>
      )}
      {(detail.developmentLink || detail.sourceKind === "local") && (
        <SettingsDisclosure title={t("settings.pluginCenter.developmentSource")}>
          <p>
            {t(
              detail.developmentLink
                ? "settings.pluginCenter.developmentLinkActive"
                : "settings.pluginCenter.developmentLinkExplanation",
            )}
          </p>
          {detail.developmentLink && (
            <p>
              <code>{detail.developmentLink.source}</code>
            </p>
          )}
          <Button
            variant="outline"
            disabled={disabled || !detail.installedDigest}
            onClick={() =>
              void mutate(
                detail.developmentLink
                  ? {
                      operation: "pluginDevelopmentUnlink",
                      id: detail.id,
                      expectedRevision: detail.revision,
                    }
                  : {
                      operation: "pluginDevelopmentLink",
                      id: detail.id,
                      expectedRevision: detail.revision,
                      expectedDigest: detail.installedDigest!,
                    },
              )
            }
          >
            {t(
              detail.developmentLink
                ? "settings.pluginCenter.stopDevelopmentLink"
                : "settings.pluginCenter.linkDevelopmentSource",
            )}
          </Button>
        </SettingsDisclosure>
      )}
    </section>
  );
}
