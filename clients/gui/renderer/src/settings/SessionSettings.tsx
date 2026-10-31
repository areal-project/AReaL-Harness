import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { Textarea } from "@areal/ui";
import { useI18n, UiMessageError, type UiMessage } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import type { Action, Data } from "../services.js";
import { EmptySettings, Feedback } from "./common.js";

import { NewSessionModelSetting } from "./NewSessionModelSetting.js";
import { useDraftBlocker } from "./UnsavedChanges.js";

const storageKeyFor = (projectId?: string, threadId?: string) =>
  `areal-gui:thread-config:${projectId}:${threadId}`;
const skillKey = (skill: Data) => `${skill.id}/${skill.revision}`;
const modelValue = (model: Data | null | undefined) =>
  model?.providerId && model?.modelId ? `${model.providerId}/${model.modelId}` : "";
const parseModel = (value: string) => {
  const slash = value.indexOf("/");
  return slash > 0 ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) } : null;
};
const parseSkill = (value: string) => {
  const slash = value.indexOf("/");
  return { id: value.slice(0, slash), revision: value.slice(slash + 1) };
};
const fromConfig = (configuration: Data): Data => {
  const skills = (configuration.selectedSkills ?? []).map(skillKey);
  return {
    baseRevision: configuration.revision,
    model: configuration.model
      ? { providerId: configuration.model.providerId, modelId: configuration.model.modelId }
      : null,
    skillMode: skills.length ? "custom" : "profile",
    skills,
    options: { ...configuration.options },
    parameters: { ...configuration.parameters },
    unknown: false,
  };
};
const readStored = (key: string) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && Number.isSafeInteger(value.baseRevision) ? value : null;
  } catch {
    return null;
  }
};
const wireOptions = (options: Data, readOnly: boolean) => ({
  ...options,
  readOnly,
  appendInstructions: options.appendInstructions ?? "",
  maxModelRounds: options.maxModelRounds ?? null,
  systemPrompt: options.systemPrompt ?? null,
  toolAllowlist: options.toolAllowlist ?? null,
  approvalTools: options.approvalTools ?? [],
  preapprovedTools: options.preapprovedTools ?? [],
});
export const wireParameters = (parameters: Data, clear: boolean) =>
  clear
    ? {}
    : {
        temperature: parameters?.temperature ?? null,
        maxOutputTokens: parameters?.maxOutputTokens ?? null,
        reasoningEffort: parameters?.reasoningEffort ?? null,
        ...(parameters?.serviceTier != null ? { serviceTier: parameters.serviceTier } : {}),
        ...(parameters?.reasoningSummary != null
          ? { reasoningSummary: parameters.reasoningSummary }
          : {}),
      };

/** 会话配置只影响 Core 接受后的后续轮次。草稿和未知结果留在本页，不自动重发。 */
export function SessionSettings({
  project,
  thread,
  action,
}: {
  project?: Data;
  thread?: Data;
  action: Action;
}) {
  const { t, locale } = useI18n();
  const configuration = thread && project?.configurations?.[thread.id];
  const storageKey = storageKeyFor(project?.id, thread?.id);
  const ready = useRef(false);
  const clean = useRef("");
  const saveRef = useRef<(revision: number, overrides?: Data) => Promise<void>>(async () => {
    throw new UiMessageError({ id: "settings.sessionSettings.selectATaskToEditItsSession" });
  });
  const [draft, setDraft] = useState<Data | null>(null);
  const [conflict, setConflict] = useState(false);
  const [readback, setReadback] = useState<Data | null>(null);
  const [rereadRevision, setRereadRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [error, setError] = useState<string | UiMessage>("");
  const [message, setMessage] = useState<string | UiMessage>("");
  const threadPending = (project?.pending ?? []).filter(
    (entry: Data) => entry.params?.threadId === thread?.id,
  );
  const pendingConfig = threadPending.some(
    (entry: Data) => entry.method === "areal/thread/configure" && !entry.awaitingResponse,
  );
  const unknown = !!draft?.unknown || pendingConfig;
  const running = !!thread?.turns?.some((turn: Data) => turn.status === "inProgress");
  const fieldsDisabled =
    busy || defaultBusy || !!thread?.desktop?.archived || running || threadPending.length > 0;
  useEffect(() => {
    if (ready.current || !configuration) return;
    ready.current = true;
    const stored = readStored(storageKey);
    const opened = fromConfig(configuration);
    clean.current = JSON.stringify(opened);
    if (stored && (stored.unknown || stored.baseRevision !== configuration.revision)) {
      setDraft(stored);
      setConflict(stored.baseRevision !== configuration.revision);
      return;
    }
    setDraft(stored ?? opened);
  }, [configuration, storageKey]);
  useEffect(() => {
    if (draft) localStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, storageKey]);
  const dirty =
    !!draft &&
    clean.current !== "" &&
    JSON.stringify({ ...draft, unknown: false }) !== clean.current;
  useDraftBlocker({
    label: { id: "settings.sessionSettings.sessionSettings" },
    dirty,
    busy: busy || defaultBusy,
    discard: () => {
      localStorage.removeItem(storageKey);
      if (configuration) {
        const next = fromConfig(configuration);
        clean.current = JSON.stringify(next);
        setDraft(next);
      }
      setConflict(false);
      setError("");
      setMessage("");
      setReadback(null);
      setRereadRevision(null);
    },
    save: async () => {
      if (unknown)
        throw new UiMessageError({
          id: "settings.sessionSettings.theConfigurationResultNeedsCheckingItWill",
        });
      if (conflict)
        throw new UiMessageError({
          id: "settings.sessionSettings.sessionSettingsChangedReloadBeforeDecidingWhether",
        });
      await saveRef.current(draft?.baseRevision);
    },
  });
  const newSessionSetting = (
    <NewSessionModelSetting
      action={action}
      disabled={busy || dirty}
      onBusyChange={setDefaultBusy}
    />
  );
  if (!project || !thread || !configuration || !draft)
    return (
      <>
        {newSessionSetting}
        <EmptySettings>{t("settings.sessionSettings.selectATaskToEditItsSession")}</EmptySettings>
      </>
    );
  const profileLocked = configuration.profile?.readOnly === true;
  const profileSkills: Data[] = configuration.profile?.skills ?? [];
  const models = (project.models ?? []).filter(
    (model: Data) => model.providerId && model.modelId && model.available !== false,
  );
  if (
    draft.model &&
    !models.some(
      (model: Data) =>
        model.providerId === draft.model.providerId && model.modelId === draft.model.modelId,
    )
  )
    models.unshift(draft.model);
  const selectedSkills =
    draft.skillMode === "profile" ? [] : (draft.skills as string[]).map(parseSkill);
  const applyLatest = (latest: Data, notice: UiMessage) => {
    const next = fromConfig(latest);
    clean.current = JSON.stringify(next);
    setDraft(next);
    setConflict(false);
    setRereadRevision(null);
    setReadback(latest);
    setError("");
    setMessage(notice);
  };
  const payloadFor = (revision: number, overrides: Data = {}) => {
    const clear = overrides.clear === true;
    const skills = overrides.selectedSkills ?? (clear ? [] : selectedSkills);
    if (!clear && draft.skillMode === "custom" && skills.length === 0)
      throw new UiMessageError({ id: "settings.sessionSettings.selectAtLeastOneSkillOrUse" });
    return {
      projectId: project.id,
      threadId: thread.id,
      expectedRevision: revision,
      model: overrides.model !== undefined ? overrides.model : clear ? null : draft.model,
      parameters: wireParameters(overrides.parameters ?? draft.parameters, clear),
      options: wireOptions(
        overrides.options ?? draft.options,
        profileLocked || (!clear && draft.options.readOnly === true),
      ),
      selectedSkills: skills,
    };
  };
  saveRef.current = async (revision: number, overrides: Data = {}) => {
    setBusy(true);
    setError("");
    try {
      await action("configure", payloadFor(revision, overrides));
      const latest = await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "inspect",
      });
      if (!latest?.configuration)
        throw new UiMessageError({
          id: "settings.sessionSettings.sessionSettingsWereSavedButCouldNot",
        });
      applyLatest(latest.configuration, { id: "settings.sessionSettings.sessionSettingsSaved" });
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (failure.submissionUnknown) {
        setDraft((current) => (current ? { ...current, unknown: true } : current));
        setError("");
        setMessage("");
        return;
      }
      if (/已变化|conflict/i.test(failure.message)) {
        setConflict(true);
        setError({
          id: "settings.sessionSettings.sessionSettingsChangedReloadBeforeDecidingWhether",
        });
        return;
      }
      setError(cause instanceof UiMessageError ? cause.descriptor : failure.message);
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: Data) =>
    setDraft((current) => (current ? { ...current, ...patch, unknown: false } : current));
  const read = async () => {
    setBusy(true);
    setError("");
    try {
      const latest = await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "inspect",
      });
      setReadback(latest.configuration);
      setRereadRevision(latest.configuration.revision);
      setMessage({ id: "settings.sessionSettings.currentSessionSettingsReloadedYourDraftIs" });
    } catch (cause) {
      setError(cause instanceof UiMessageError ? cause.descriptor : (cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    setError("");
    try {
      await action("reconcile", { projectId: project.id });
      const latest = await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "inspect",
      });
      setReadback(latest.configuration);
      setMessage({
        id: "settings.sessionSettings.currentSessionSettingsReloadedUnconfirmedChangesWere",
      });
    } catch (cause) {
      setError(cause instanceof UiMessageError ? cause.descriptor : (cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {newSessionSetting}
      <form
        className="settings-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!fieldsDisabled && !conflict) void saveRef.current(draft.baseRevision);
        }}
      >
        <fieldset disabled={fieldsDisabled} className="m-0 space-y-6 border-0 p-0">
          <SettingsSection
            title={t("settings.sessionSettings.sessionModel")}
            description={t("settings.sessionSettings.newMessagesUseThisModelQueuedMessages")}
          >
            <SettingsGroupCard>
              <SettingsRow
                label={t("settings.sessionSettings.model")}
                control={
                  <SettingsSelect
                    aria-label={t("settings.sessionSettings.sessionModel")}
                    value={modelValue(draft.model)}
                    onValueChange={(selectedValue) => update({ model: parseModel(selectedValue) })}
                  >
                    <option value="">{t("settings.sessionSettings.presetOrServiceDefault")}</option>
                    {models.map((model: Data) => (
                      <option key={modelValue(model)} value={modelValue(model)}>
                        {model.displayName || model.modelId}
                      </option>
                    ))}
                  </SettingsSelect>
                }
              />
            </SettingsGroupCard>
          </SettingsSection>
          <SettingsSection
            title={t("settings.sessionSettings.sessionPermissionsAndSafety")}
            description={t("settings.sessionSettings.appliesToNewMessagesWithinDeploymentAnd")}
          >
            <SettingsGroupCard>
              <SettingsRow
                label={t("settings.sessionSettings.readOnlyMode")}
                description={
                  profileLocked
                    ? t("settings.sessionSettings.theCurrentPresetRequiresReadOnlyMode")
                    : t("settings.sessionSettings.restrictWritesAndHighRiskOperations")
                }
                control={
                  <Switch
                    aria-label={t("settings.sessionSettings.readOnlyMode")}
                    checked={profileLocked || draft.options.readOnly === true}
                    disabled={fieldsDisabled || profileLocked}
                    onCheckedChange={(readOnly) =>
                      update({ options: { ...draft.options, readOnly } })
                    }
                  />
                }
              />
              <SettingsRow
                label={t("settings.sessionSettings.maximumModelCallsPerTurn")}
                description={t("settings.sessionSettings.safetyLimit11024")}
                control={
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      aria-label={t("settings.sessionSettings.maximumModelCallsPerTurn")}
                      min={1}
                      max={1024}
                      value={draft.options.maxModelRounds ?? ""}
                      className="w-20 text-center"
                      onChange={(event) =>
                        update({
                          options: {
                            ...draft.options,
                            maxModelRounds:
                              event.target.value === "" ? null : Number(event.target.value),
                          },
                        })
                      }
                    />
                    <span className="text-ui-sm text-foreground-subtle">
                      {t("settings.sessionSettings.calls")}
                    </span>
                  </div>
                }
              />
            </SettingsGroupCard>
          </SettingsSection>
          <SettingsSection
            title={t("settings.sessionSettings.instructions")}
            description={t("settings.sessionSettings.appendedToFutureMessagesRestoreDefaultsTo")}
          >
            <SettingsGroupCard>
              <div className="space-y-2 p-4">
                <div className="settings-field-label">
                  {t("settings.sessionSettings.additionalInstructions")}
                </div>
                <Textarea
                  unstyled
                  data-slot={undefined}
                  rows={4}
                  aria-label={t("settings.sessionSettings.additionalInstructions")}
                  value={draft.options.appendInstructions ?? ""}
                  onChange={(event) =>
                    update({
                      options: { ...draft.options, appendInstructions: event.target.value },
                    })
                  }
                />
              </div>
            </SettingsGroupCard>
          </SettingsSection>
          <SettingsSection
            title={t("settings.sessionSettings.sessionSkills")}
            description={t("settings.sessionSettings.chooseSkillsAvailableForFutureExecution")}
          >
            <SettingsGroupCard>
              <SettingsRow
                label={t("settings.sessionSettings.skillScope")}
                control={
                  <SettingsSelect
                    aria-label={t("settings.sessionSettings.sessionSkillScope")}
                    value={draft.skillMode}
                    onValueChange={(selectedValue) =>
                      update({
                        skillMode: selectedValue,
                        skills: selectedValue === "profile" ? [] : draft.skills,
                      })
                    }
                  >
                    <option value="profile">{t("settings.sessionSettings.allPresetSkills")}</option>
                    <option value="custom">{t("settings.sessionSettings.selectedSkills")}</option>
                  </SettingsSelect>
                }
              />
              <div className="space-y-3 px-4 pb-4">
                {draft.skillMode === "custom" &&
                  profileSkills.map((skill) => {
                    const key = skillKey(skill);
                    return (
                      <label key={key} className="flex items-center gap-2">
                        <Input
                          unstyled
                          data-slot={undefined}
                          type="checkbox"
                          aria-label={`${skill.id} · ${skill.revision}`}
                          checked={draft.skills.includes(key)}
                          onChange={(event) =>
                            update({
                              skills: event.target.checked
                                ? [...draft.skills, key]
                                : draft.skills.filter((item: string) => item !== key),
                            })
                          }
                        />
                        {skill.id} · {skill.revision}
                      </label>
                    );
                  })}
                {draft.skillMode === "custom" && !profileSkills.length && (
                  <p>{t("settings.sessionSettings.noSelectableSkillsInTheCurrentPreset")}</p>
                )}
              </div>
            </SettingsGroupCard>
          </SettingsSection>
          <SettingsSection
            title={t("settings.sessionSettings.modelParameters")}
            description={t("settings.sessionSettings.leaveBlankToUseModelDefaults")}
          >
            <SettingsGroupCard>
              <SettingsRow
                label={t("settings.sessionSettings.temperature")}
                description={t("settings.sessionSettings.samplingRandomness0020")}
                control={
                  <Input
                    type="number"
                    aria-label={t("settings.sessionSettings.temperature2")}
                    min={0}
                    max={2}
                    step={0.1}
                    value={draft.parameters.temperature ?? ""}
                    className="w-24 text-center"
                    onChange={(event) =>
                      update({
                        parameters: {
                          ...draft.parameters,
                          temperature:
                            event.target.value === "" ? null : Number(event.target.value),
                        },
                      })
                    }
                  />
                }
              />
              <SettingsRow
                label={t("settings.sessionSettings.maximumOutputTokens")}
                description={t("settings.sessionSettings.maximumTokensGeneratedInOneModelResponse")}
                control={
                  <Input
                    type="number"
                    aria-label={t("settings.sessionSettings.maximumOutputTokens")}
                    min={1}
                    value={draft.parameters.maxOutputTokens ?? ""}
                    className="w-24 text-center"
                    onChange={(event) =>
                      update({
                        parameters: {
                          ...draft.parameters,
                          maxOutputTokens:
                            event.target.value === "" ? null : Number(event.target.value),
                        },
                      })
                    }
                  />
                }
              />
            </SettingsGroupCard>
          </SettingsSection>
        </fieldset>
        {running && (
          <p role="status">{t("settings.sessionSettings.thisTaskIsRunningChangeSettingsAfter")}</p>
        )}
        {thread.desktop?.archived && (
          <p role="status">
            {t("settings.sessionSettings.archivedTasksAreReadOnlySessionSettings")}
          </p>
        )}
        {unknown && (
          <p role="status">
            {t("settings.sessionSettings.theConfigurationResultNeedsCheckingYourDraft")}
          </p>
        )}
        <Feedback error={error} message={message} />
        <div className="settings-form-actions">
          <Button type="submit" disabled={fieldsDisabled || conflict}>
            {t("settings.sessionSettings.saveSessionSettings")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={fieldsDisabled || conflict}
            onClick={() =>
              void saveRef.current(draft.baseRevision, {
                clear: true,
                model: null,
                selectedSkills: [],
                options: {
                  ...draft.options,
                  readOnly: profileLocked,
                  appendInstructions: "",
                  maxModelRounds: null,
                },
              })
            }
          >
            {t("settings.sessionSettings.restoreDefaults")}
          </Button>
          {conflict && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void read()}>
              {t("settings.sessionSettings.reload")}
            </Button>
          )}
          {conflict && (
            <Button
              type="button"
              disabled={busy || rereadRevision == null}
              onClick={() => void saveRef.current(rereadRevision as number)}
            >
              {t("settings.sessionSettings.resubmitCurrentDraft")}
            </Button>
          )}
          {conflict && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !readback}
              onClick={() =>
                applyLatest(readback as Data, {
                  id: "settings.sessionSettings.latestSettingsAdoptedTheyHaveNotBeen",
                })
              }
            >
              {t("settings.sessionSettings.useLatestSettings")}
            </Button>
          )}
          {unknown && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void verify()}>
              {t("settings.sessionSettings.reviewSessionSettings")}
            </Button>
          )}
        </div>
        {readback && (
          <section aria-label={t("settings.sessionSettings.reloadedSessionSettings")}>
            <p>
              {t("settings.sessionSettings.revision")}
              {readback.revision}
            </p>
            <p>
              {t("settings.sessionSettings.model2")}
              {readback.model
                ? `${readback.model.providerId}/${readback.model.modelId}`
                : t("settings.sessionSettings.presetOrServiceDefault")}
            </p>
            <p>
              {t("settings.sessionSettings.additionalInstructions2")}
              {readback.options?.appendInstructions || t("settings.sessionSettings.none")}
            </p>
            <p>
              {t("settings.sessionSettings.skills")}
              {readback.selectedSkills?.length
                ? readback.selectedSkills
                    .map((skill: Data) => `${skill.id} · ${skill.revision}`)
                    .join(locale === "zh-CN" ? "、" : ", ")
                : t("settings.sessionSettings.allPresetSkills2")}
            </p>
            <p>
              {t("settings.sessionSettings.maximumModelCallsPerTurn2")}
              {readback.options?.maxModelRounds ?? t("settings.sessionSettings.unlimited")}
            </p>
            <p>
              {t("settings.sessionSettings.temperature3")}
              {readback.parameters?.temperature ?? t("settings.sessionSettings.default")}
            </p>
            <p>
              {t("settings.sessionSettings.maximumOutputTokens2")}
              {readback.parameters?.maxOutputTokens ?? t("settings.sessionSettings.default")}
            </p>
            <p>
              {t("settings.sessionSettings.readOnly")}
              {readback.readOnly === true
                ? t("settings.sessionSettings.yes")
                : t("settings.sessionSettings.no")}
            </p>
          </section>
        )}
      </form>
    </>
  );
}
