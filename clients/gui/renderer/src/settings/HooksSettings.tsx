import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { Textarea } from "@areal/ui";
import { useI18n, UiMessageError, type UiMessage } from "../i18n/IntlProvider.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { useRef, useState } from "react";
import type { Action } from "../services.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Feedback, SettingsDialog, useResource } from "./common.js";

import type { Hook } from "../services.js";
type Hooks = {
  path: string;
  external: boolean;
  revision: string;
  hooks: Hook[];
  projects: { projectId: string; root: string; connected: boolean; applied: boolean }[];
};
type Draft = {
  source: string;
  revision: string;
  hooks: Hook[];
  index: number;
  name: string;
  event: Hook["event"];
  matcher: string;
  argv: string;
  timeout: string;
};
const draftKey = "areal-hooks-editor";
function savedDraft(): Draft | null {
  try {
    return JSON.parse(localStorage.getItem(draftKey) || "null");
  } catch {
    return null;
  }
}

export function HooksSettings({
  action,
  connected,
  onConnect,
}: {
  action: Action;
  connected: boolean;
  onConnect: () => Promise<void>;
}) {
  const { t, intl } = useI18n();
  const state = useResource(() => action("resources", { operation: "hooks" }), String(connected));
  const value = state.value as Hooks | undefined;
  const [draft, setDraft] = useState<Draft | null>(savedDraft),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiMessage | string>(""),
    [notice, setNotice] = useState<UiMessage | string>("");
  const [deleting, setDeleting] = useState(false);
  const locked = useRef(false);
  const update = (next: Draft | null) => {
    setDraft(next);
    if (!next) setDeleting(false);
    if (next) localStorage.setItem(draftKey, JSON.stringify(next));
    else localStorage.removeItem(draftKey);
  };
  const edit = (index: number) => {
    if (!value) return;
    const item = value.hooks[index];
    setError("");
    setNotice("");
    update({
      source: value.path,
      revision: value.revision,
      hooks: value.hooks,
      index,
      name: item?.name ?? "",
      event: item?.event ?? "PreToolUse",
      matcher: item?.matcher ?? "*",
      argv: JSON.stringify(item?.argv ?? [], null, 2),
      timeout: String(item?.timeoutMs ?? 10000),
    });
  };
  const run = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof UiMessageError ? cause.descriptor : (cause as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      if (!draft || !value) return;
      if (draft.source !== value.path)
        throw new UiMessageError({
          id: "settings.hooksSettings.theConfigurationSourceChangedCancelEditingAnd",
        });
      const argv = JSON.parse(draft.argv);
      if (!Array.isArray(argv) || argv.some((v) => typeof v !== "string"))
        throw new UiMessageError({ id: "settings.hooksSettings.commandArgumentsMustBeAJSONArray" });
      const hook: Hook = {
        name: draft.name,
        event: draft.event,
        matcher: draft.matcher,
        argv,
        timeoutMs: Number(draft.timeout),
      };
      const hooks =
        draft.index < 0
          ? [...draft.hooks, hook]
          : draft.hooks.map((h, i) => (i === draft.index ? hook : h));
      await action("resources", {
        operation: "hooksSave",
        expectedRevision: draft.revision,
        hooks,
      });
      update(null);
      await state.refresh();
      setNotice({ id: "settings.hooksSettings.configurationSavedRestartTheBackendToApply" });
    });
  const move = (index: number, direction: number) =>
    run(async () => {
      if (!value) return;
      const hooks = [...value.hooks];
      [hooks[index], hooks[index + direction]] = [hooks[index + direction], hooks[index]];
      await action("resources", {
        operation: "hooksSave",
        expectedRevision: value.revision,
        hooks,
      });
      await state.refresh();
      setNotice({ id: "settings.hooksSettings.configurationSavedRestartTheBackendToApply" });
    });
  const remove = () =>
    run(async () => {
      if (!draft || !value || draft.source !== value.path || draft.index < 0) return;
      await action("resources", {
        operation: "hooksSave",
        expectedRevision: draft.revision,
        hooks: draft.hooks.filter((_, index) => index !== draft.index),
      });
      update(null);
      await state.refresh();
      setNotice({ id: "settings.hooksSettings.configurationSavedRestartTheBackendToApply" });
    });
  const apply = () =>
    run(async () => {
      if (connected) {
        const result = await action("stopService", {});
        if ("canceled" in result) {
          setNotice({ id: "settings.hooksSettings.restartCancelledYourConfigurationIsSaved" });
          return;
        }
        if (!result.stopped)
          throw new UiMessageError({
            id: "settings.hooksSettings.theBackendHasNotStoppedConfigurationHas",
          });
      }
      await onConnect();
      await state.refresh();
      setNotice({ id: "settings.hooksSettings.theBackendReconnectedCheckTheLoadStatus" });
    });
  const disabled = busy || !connected || state.loading || !!state.error;
  return (
    <div className="settings-sections" aria-label={t("settings.hooksSettings.hookManagement")}>
      <p className="settings-section-desc">
        {t("settings.hooksSettings.runToolEventCommandsInOrderRestart")}
      </p>
      <Feedback error={draft ? undefined : error || state.error} message={notice} />
      <SettingsSection
        title={t("settings.hooksSettings.toolHooks")}
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !connected}
              onClick={() => void state.refresh()}
            >
              {t("settings.hooksSettings.refreshHooks")}
            </Button>
            <Button
              size="sm"
              disabled={disabled || !value || !!draft || value.hooks.length >= 64}
              onClick={() => edit(-1)}
            >
              {t("settings.hooksSettings.addHook")}
            </Button>
          </div>
        }
      >
        <SettingsGroupCard>
          {value?.hooks.map((hook, index) => (
            <SettingsRow
              key={hook.name}
              label={hook.name}
              description={`${hook.event} · ${hook.matcher} · ${intl.formatNumber(hook.timeoutMs)} ms`}
              control={
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("settings.hooksSettings.moveValueUp", { value0: hook.name })}
                    disabled={disabled || !!draft || index === 0}
                    onClick={() => void move(index, -1)}
                  >
                    {t("settings.hooksSettings.moveUp")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("settings.hooksSettings.moveValueDown", { value0: hook.name })}
                    disabled={disabled || !!draft || index === value.hooks.length - 1}
                    onClick={() => void move(index, 1)}
                  >
                    {t("settings.hooksSettings.moveDown")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || !!draft}
                    onClick={() => edit(index)}
                  >
                    {t("settings.hooksSettings.editHookNamed", { value0: hook.name })}
                  </Button>
                </div>
              }
            />
          ))}
          {value && !value.hooks.length && (
            <p className="p-4 settings-section-desc">
              {t("settings.hooksSettings.noHooksConfigured")}
            </p>
          )}
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection
        title={t("settings.hooksSettings.applyConfiguration")}
        description={t("settings.hooksSettings.savingDoesNotInterruptExecutionApplyingChanges")}
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !!draft || !value}
            onClick={() => void apply()}
          >
            {connected
              ? t("settings.hooksSettings.restartBackendAndApply")
              : t("settings.hooksSettings.connectBackendAndApply")}
          </Button>
        }
      >
        <SettingsGroupCard>
          {value?.projects.map((p) => (
            <SettingsRow
              key={p.projectId}
              label={p.root.split(/[\\/]/).at(-1) || p.root}
              control={
                <span>
                  {!connected || !p.connected
                    ? t("settings.hooksSettings.loadOnNextStart")
                    : p.applied
                      ? t("settings.hooksSettings.currentConfigurationLoaded")
                      : t("settings.hooksSettings.restartRequiredToApply")}
                </span>
              }
            />
          ))}
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsDisclosure title={t("settings.hooksSettings.configurationDetails")}>
        <p className="settings-section-desc break-all">
          {value?.path ?? t("settings.hooksSettings.loadingConfigurationSource")}
        </p>
        <p className="settings-section-desc">
          {t("settings.hooksSettings.manageCoreExtensionHooksOtherFormatsFrom")}
        </p>
        <p className="settings-section-desc">
          {t("settings.hooksSettings.restartingDisconnectsAllWindowsRunningTasksTerminals")}
        </p>
      </SettingsDisclosure>
      {draft && (
        <SettingsDialog
          title={
            draft.index < 0
              ? t("settings.hooksSettings.addHook")
              : t("settings.hooksSettings.editHook")
          }
          description={t("settings.hooksSettings.commandsReceiveOneLineOfEventJSON")}
          busy={busy}
          onClose={() => update(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="grid gap-3"
          >
            <Feedback error={error || state.error} />
            {state.error && (
              <Button
                type="button"
                variant="outline"
                disabled={busy || !connected}
                onClick={() => void state.refresh()}
              >
                {t("settings.hooksSettings.reloadHookConfiguration")}
              </Button>
            )}
            <label>
              {t("settings.hooksSettings.hookName")}
              <Input
                aria-label={t("settings.hooksSettings.hookName")}
                required
                disabled={busy}
                value={draft.name}
                onChange={(e) => update({ ...draft, name: e.target.value })}
              />
            </label>
            <div className="settings-choice-field">
              {t("settings.hooksSettings.triggerEvent")}
              <SettingsSelect
                aria-label={t("settings.hooksSettings.triggerEvent")}
                disabled={busy}
                value={draft.event}
                onValueChange={(event) => {
                  if (
                    event === "PreToolUse" ||
                    event === "PostToolUse" ||
                    event === "PostToolUseFailure"
                  )
                    update({ ...draft, event });
                }}
              >
                <option value="PreToolUse">
                  {t("settings.hooksSettings.beforeToolExecution")}
                </option>
                <option value="PostToolUse">{t("settings.hooksSettings.afterToolSuccess")}</option>
                <option value="PostToolUseFailure">
                  {t("settings.hooksSettings.afterToolFailure")}
                </option>
              </SettingsSelect>
            </div>
            <label>
              {t("settings.hooksSettings.matchTools")}
              <Input
                aria-label={t("settings.hooksSettings.matchTools")}
                required
                disabled={busy}
                value={draft.matcher}
                onChange={(e) => update({ ...draft, matcher: e.target.value })}
              />
            </label>
            <label>
              {t("settings.hooksSettings.commandArgumentsJSONArray")}
              <Textarea
                unstyled
                data-slot={undefined}
                aria-label={t("settings.hooksSettings.commandArgumentsJSONArray")}
                className="w-full min-h-32 font-mono"
                disabled={busy}
                value={draft.argv}
                onChange={(e) => update({ ...draft, argv: e.target.value })}
              />
            </label>
            <label>
              {t("settings.hooksSettings.timeoutMs")}
              <Input
                type="number"
                aria-label={t("settings.hooksSettings.timeoutMs")}
                required
                disabled={busy}
                value={draft.timeout}
                onChange={(e) => update({ ...draft, timeout: e.target.value })}
              />
            </label>
            {deleting ? (
              <div
                role="group"
                aria-label={t("settings.hooksSettings.confirmHookDeletion")}
                className="grid gap-2"
              >
                <p>
                  {t("settings.hooksSettings.deleteHookConfirmation", {
                    name: draft.hooks[draft.index]?.name,
                  })}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDeleting(false)}
                  >
                    {t("settings.hooksSettings.cancelDeletion")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={disabled}
                    onClick={() => void remove()}
                  >
                    {t("settings.hooksSettings.confirmHookDeletion")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                {draft.index >= 0 && (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={disabled}
                    onClick={() => setDeleting(true)}
                  >
                    {t("settings.hooksSettings.deleteHook2")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => update(null)}
                >
                  {t("settings.hooksSettings.cancel")}
                </Button>
                <Button type="submit" disabled={disabled}>
                  {t("settings.hooksSettings.saveHook")}
                </Button>
              </div>
            )}
          </form>
        </SettingsDialog>
      )}
    </div>
  );
}
