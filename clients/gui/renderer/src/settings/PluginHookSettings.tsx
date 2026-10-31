import type { PluginCommand, PluginMutationRequest } from "./pluginTypes.js";
import { Input } from "@areal/ui";
import { useI18n, UiMessageError, type UiMessage } from "../i18n/IntlProvider.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Feedback } from "./common.js";

type RecordValue = Record<string, unknown>;
type Definition = {
  id: string;
  event: string;
  matcher: string | null;
  handler: RecordValue;
  timeout_secs: number;
  status_message?: string | null;
  async: boolean;
};
type HookView = {
  pluginId: string;
  installedDigest: string;
  definitionDigest: string;
  definitions: { definition: Definition; trusted: boolean; readOnlyCommandTrusted: boolean }[];
  diagnostics: string[];
};
type Props = {
  projectId: string;
  id: string;
  installedDigest: string;
  disabled: boolean;
  api: PluginCommand;
  onConfigure: (
    parameters: Omit<
      Extract<PluginMutationRequest, { operation: "pluginHooksConfigure" }>,
      "operation"
    >,
  ) => Promise<void> | void;
  refreshKey?: string | number;
};
const object = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function readView(value: unknown, id: string, digest: string): HookView {
  if (!object(value) || !Array.isArray(value.data))
    throw new UiMessageError({
      id: "settings.pluginHookSettings.thePluginHookResponseFormatIsInvalid",
    });
  const row: unknown = value.data.find((entry: unknown) => object(entry) && entry.pluginId === id);
  if (!object(row))
    throw new UiMessageError({
      id: "settings.pluginHookSettings.hooksAreUnavailableForThisPluginRefresh",
    });
  if (row.installedDigest !== digest)
    throw new UiMessageError({
      id: "settings.pluginHookSettings.theInstalledPackageChangedRefreshThePlugin",
    });
  if (
    typeof row.definitionDigest !== "string" ||
    !row.definitionDigest ||
    !Array.isArray(row.definitions) ||
    !Array.isArray(row.diagnostics) ||
    !row.diagnostics.every((d: unknown) => typeof d === "string")
  ) {
    throw new UiMessageError({
      id: "settings.pluginHookSettings.thePluginHookResponseFormatIsInvalid",
    });
  }
  const definitions = row.definitions.map((entry: unknown) => {
    if (
      !object(entry) ||
      typeof entry.trusted !== "boolean" ||
      typeof entry.readOnlyCommandTrusted !== "boolean" ||
      !object(entry.definition)
    )
      throw new UiMessageError({
        id: "settings.pluginHookSettings.theHookDefinitionFormatIsInvalid",
      });
    const definition = entry.definition;
    if (
      typeof definition.id !== "string" ||
      typeof definition.event !== "string" ||
      (definition.matcher !== null && typeof definition.matcher !== "string") ||
      !object(definition.handler) ||
      typeof definition.timeout_secs !== "number" ||
      !Number.isFinite(definition.timeout_secs) ||
      typeof definition.async !== "boolean" ||
      (definition.status_message != null && typeof definition.status_message !== "string")
    ) {
      throw new UiMessageError({
        id: "settings.pluginHookSettings.theHookDefinitionFormatIsInvalid",
      });
    }
    return {
      definition: definition as Definition,
      trusted: entry.trusted,
      readOnlyCommandTrusted: entry.readOnlyCommandTrusted,
    };
  });
  return {
    pluginId: id,
    installedDigest: digest,
    definitionDigest: row.definitionDigest,
    definitions,
    diagnostics: row.diagnostics as string[],
  };
}
const message = (error: unknown): string | UiMessage =>
  error instanceof UiMessageError
    ? error.descriptor
    : error instanceof Error
      ? error.message
      : { id: "settings.pluginHookSettings.couldNotLoadPluginHooks" };

export function PluginHookSettings({
  projectId,
  id,
  installedDigest,
  disabled,
  api,
  onConfigure,
  refreshKey,
}: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<HookView>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiMessage | string>("");
  const [reviewedIdentity, setReviewedIdentity] = useState<string>();
  const [readOnlyReviewedIdentity, setReadOnlyReviewedIdentity] = useState<string>();
  const generation = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = readView(
        await apiRef.current({ operation: "pluginHooks", projectId }),
        id,
        installedDigest,
      );
      if (generation.current === request) {
        const nextIdentity = JSON.stringify([id, installedDigest, next.definitionDigest]);
        setReviewedIdentity((previous) => (previous === nextIdentity ? previous : undefined));
        setReadOnlyReviewedIdentity((previous) =>
          previous === nextIdentity ? previous : undefined,
        );
        setView(next);
      }
    } catch (cause) {
      if (generation.current === request) {
        setError(message(cause));
        setView(undefined);
        setReviewedIdentity(undefined);
        setReadOnlyReviewedIdentity(undefined);
      }
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [id, installedDigest, projectId]);
  useEffect(() => {
    setReviewedIdentity(undefined);
    setReadOnlyReviewedIdentity(undefined);
    setView(undefined);
    setBusy(false);
    void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh, refreshKey]);
  // Identity gating also applies during the render preceding effect cleanup.
  const current =
    view?.pluginId === id && view.installedDigest === installedDigest ? view : undefined;
  const identity = current
    ? JSON.stringify([id, installedDigest, current.definitionDigest])
    : undefined;
  const reviewed = !!identity && reviewedIdentity === identity;
  const hasCommands =
    current?.definitions.some((entry) => entry.definition.handler.type === "command") ?? false;
  const readOnlyReviewed = reviewed && !!identity && readOnlyReviewedIdentity === identity;
  const blocked = disabled || loading || busy || !current || !!error;
  const configure = async (trusted: boolean) => {
    if (blocked || !current || (trusted && !reviewed)) return;
    const request = generation.current;
    const allowReadOnlyCommands = trusted && hasCommands && readOnlyReviewed;
    setBusy(true);
    setError("");
    setReviewedIdentity(undefined);
    setReadOnlyReviewedIdentity(undefined);
    try {
      // The parent owns durable submission/UNKNOWN recovery. Never retry this mutation.
      await onConfigure({
        id,
        expectedDigest: installedDigest,
        definitionDigest: current.definitionDigest,
        enabled: trusted,
        trusted,
        allowReadOnlyCommands,
      });
      if (generation.current === request) {
        setBusy(false);
        await refresh();
      }
    } catch (cause) {
      if (generation.current === request)
        setError(
          cause instanceof UiMessageError
            ? cause.descriptor
            : cause instanceof Error
              ? cause.message
              : {
                  id: "settings.pluginHookSettings.hookConfigurationIsIncompleteCheckSubmissionStatus",
                },
        );
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };
  if (current && current.definitions.length === 0 && current.diagnostics.length === 0 && !error)
    return null;
  return (
    <section
      aria-label={t("settings.pluginHookSettings.pluginHooks")}
      className="plugin-detail-resources space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h4>{t("settings.pluginHookSettings.pluginHooks")}</h4>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || busy || loading}
          onClick={() => void refresh()}
        >
          {t("settings.pluginHookSettings.refreshHooks")}
        </Button>
      </div>
      <p className="text-foreground-subtle text-ui-sm">
        {t("settings.pluginHookSettings.hooksCanRunShellCommandsOrCall")}
      </p>
      <Feedback
        error={error}
        message={
          loading ? t("settings.pluginHookSettings.loadingHooksFromTheInstalledPackage") : undefined
        }
      />
      {current && (
        <>
          <SettingsDisclosure title={t("settings.pluginHookSettings.hookSummary")}>
            <dl className="text-ui-sm space-y-1">
              <dt>{t("settings.pluginHookSettings.installedPackageDigest")}</dt>
              <dd className="break-all font-mono">{current.installedDigest}</dd>
              <dt>{t("settings.pluginHookSettings.currentDefinitionDigest")}</dt>
              <dd className="break-all font-mono">{current.definitionDigest}</dd>
            </dl>
          </SettingsDisclosure>
          {current.diagnostics.map((diagnostic, index) => (
            <p className="text-ui-sm" key={index}>
              {diagnostic}
            </p>
          ))}
          {current.definitions.length === 0 ? (
            <p>{t("settings.pluginHookSettings.theInstalledPackageHasNoExecutableHook")}</p>
          ) : (
            <>
              <ul className="space-y-3">
                {current.definitions.map(
                  ({ definition, trusted, readOnlyCommandTrusted }, index) => (
                    <li
                      key={`${definition.id}:${index}`}
                      className="space-y-1 rounded-md border p-3"
                    >
                      <p>
                        <strong>{definition.event}</strong> ·{" "}
                        {trusted
                          ? t("settings.pluginHookSettings.currentDefinitionsTrusted")
                          : t("settings.pluginHookSettings.trustNotGranted")}
                      </p>
                      {definition.handler.type === "command" && (
                        <p className="text-ui-sm">
                          {t("settings.pluginHookSettings.readOnlyCommandPermission", {
                            trusted: String(readOnlyCommandTrusted),
                          })}
                        </p>
                      )}
                      <p className="text-ui-sm">
                        {t("settings.pluginHookSettings.hookExecutionSummary", {
                          matcher: definition.matcher || t("settings.pluginHookSettings.all"),
                          timeout: definition.timeout_secs,
                          mode: definition.async ? "background" : "synchronous",
                        })}
                      </p>
                      {definition.status_message && (
                        <p className="text-ui-sm">
                          {t("settings.pluginHookSettings.statusMessageValue", {
                            message: definition.status_message,
                          })}
                        </p>
                      )}
                      <p className="text-ui-sm">
                        {definition.handler.type === "command"
                          ? t("settings.pluginHookSettings.shellCommand")
                          : t("settings.pluginHookSettings.mcpToolAndArguments")}
                      </p>
                      <pre className="whitespace-pre-wrap break-all text-ui-sm">
                        {definition.handler.type === "command"
                          ? String(definition.handler.command ?? "")
                          : JSON.stringify(definition.handler, null, 2)}
                      </pre>
                      {typeof definition.handler.command_windows === "string" && (
                        <p className="whitespace-pre-wrap break-all text-ui-sm">
                          {t("settings.pluginHookSettings.windowsCommandValue", {
                            command: definition.handler.command_windows,
                          })}
                        </p>
                      )}
                      <SettingsDisclosure
                        title={<> {t("settings.pluginHookSettings.fullDefinition")}</>}
                      >
                        <pre className="whitespace-pre-wrap break-all text-ui-sm">
                          {JSON.stringify(definition, null, 2)}
                        </pre>
                      </SettingsDisclosure>
                    </li>
                  ),
                )}
              </ul>
              <label className="flex items-start gap-2 text-ui-sm">
                <Input
                  unstyled
                  data-slot={undefined}
                  type="checkbox"
                  checked={reviewed}
                  disabled={blocked}
                  onChange={(event) => {
                    setReviewedIdentity(event.target.checked ? identity : undefined);
                    if (!event.target.checked) setReadOnlyReviewedIdentity(undefined);
                  }}
                />
                {t("settings.pluginHookSettings.iHaveReviewedThePackageDigestAll")}
              </label>
              {hasCommands && (
                <label className="flex items-start gap-2 text-ui-sm">
                  <Input
                    unstyled
                    data-slot={undefined}
                    type="checkbox"
                    checked={readOnlyReviewed}
                    disabled={blocked || !reviewed}
                    onChange={(event) =>
                      setReadOnlyReviewedIdentity(event.target.checked ? identity : undefined)
                    }
                  />
                  {t("settings.pluginHookSettings.separatelyAllowTheCommandHooksAboveTo")}
                </label>
              )}
              <div className="settings-form-actions">
                <Button disabled={blocked || !reviewed} onClick={() => void configure(true)}>
                  {t("settings.pluginHookSettings.trustAndEnableCurrentHooks")}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    blocked ||
                    !current.definitions.some(
                      (entry) => entry.trusted || entry.readOnlyCommandTrusted,
                    )
                  }
                  onClick={() => void configure(false)}
                >
                  {t("settings.pluginHookSettings.revokeHookTrustAndDisable")}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
