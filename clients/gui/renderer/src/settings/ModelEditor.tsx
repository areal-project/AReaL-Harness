import { useI18n, type UiMessage } from "../i18n/IntlProvider.js";
import { useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { Feedback } from "../components/ui/feedback.js";
import { SettingsDialog } from "./common.js";
import type { Data } from "../services.js";
import "./ModelEditor.css";

const reasoningEfforts = [
  ["none", "settings.modelEditor.effortNone"],
  ["minimal", "settings.modelEditor.effortMinimal"],
  ["low", "settings.modelEditor.effortLow"],
  ["medium", "settings.modelEditor.effortMedium"],
  ["high", "settings.modelEditor.effortHigh"],
  ["xhigh", "settings.modelEditor.effortExtraHigh"],
  ["max", "settings.modelEditor.effortMaximum"],
] as const;

export function ModelEditor({
  model,
  editing,
  ids,
  onSave,
  onClose,
}: {
  model: Data;
  editing: boolean;
  ids: string[];
  onSave: (model: Data) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [id, setId] = useState(model.id ?? "");
  const [name, setName] = useState(model.displayName ?? "");
  const [context, setContext] = useState(String(model.parameters?.contextWindowTokens ?? ""));
  const [maximum, setMaximum] = useState(String(model.parameters?.maxOutputTokens ?? ""));
  const initialTools = model.capabilities?.tools ?? true;
  const initialVision = model.capabilities?.vision ?? true;
  const initialReasoning = model.capabilities?.reasoning ?? true;
  const initialEfforts: string[] = model.capabilities?.reasoningEffortOptions ?? [];
  const [tools, setTools] = useState(initialTools);
  const [vision, setVision] = useState(initialVision);
  const [reasoning, setReasoning] = useState(initialReasoning);
  const [efforts, setEfforts] = useState<string[]>(initialEfforts);
  const [error, setError] = useState<UiMessage>();
  const [invalidField, setInvalidField] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const idInput = useRef<HTMLInputElement>(null);
  const contextInput = useRef<HTMLInputElement>(null);
  const maximumInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const capabilitiesChanged =
    tools !== initialTools ||
    vision !== initialVision ||
    reasoning !== initialReasoning ||
    JSON.stringify(efforts) !== JSON.stringify(initialEfforts);
  const dirty =
    id !== (model.id ?? "") ||
    name !== (model.displayName ?? "") ||
    context !== String(model.parameters?.contextWindowTokens ?? "") ||
    maximum !== String(model.parameters?.maxOutputTokens ?? "") ||
    capabilitiesChanged;
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const invalid = (field: string) => ({
    "aria-invalid": invalidField === field || undefined,
    "aria-describedby": invalidField === field ? errorId : undefined,
  });
  const fail = (field: string, message: UiMessage, input: HTMLInputElement | null) => {
    setInvalidField(field);
    setError(message);
    input?.focus();
  };
  return (
    <SettingsDialog
      title={editing ? t("settings.modelEditor.editModel") : t("settings.modelEditor.addModel")}
      description={t("settings.modelEditor.setTheModelNameLimitsAndSupported")}
      className="model-editor-dialog"
      onClose={requestClose}
    >
      <form
        className="model-editor"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!id.trim() || ids.includes(id.trim())) {
            fail(
              "id",
              { id: "settings.modelEditor.modelIDMustBeUniqueAndCannot" },
              idInput.current,
            );
            return;
          }
          if (
            contextInput.current?.validity.badInput ||
            (context &&
              (!Number.isSafeInteger(Number(context)) ||
                Number(context) <= 0 ||
                Number(context) > 2_000_000))
          ) {
            fail(
              "context",
              { id: "settings.modelEditor.contextLengthMustBeAnIntegerBetween" },
              contextInput.current,
            );
            return;
          }
          if (
            maximumInput.current?.validity.badInput ||
            (maximum && (!Number.isSafeInteger(Number(maximum)) || Number(maximum) <= 0))
          ) {
            fail(
              "maximum",
              { id: "settings.modelEditor.maximumOutputMustBeAPositiveInteger" },
              maximumInput.current,
            );
            return;
          }
          const parameters = { ...model.parameters };
          delete parameters.contextWindowTokens;
          delete parameters.maxOutputTokens;
          if (!editing || capabilitiesChanged) {
            if (!reasoning) {
              delete parameters.reasoningEffort;
              delete parameters.reasoningSummary;
            }
          }
          onSave({
            ...model,
            id: id.trim(),
            ...(id.trim() === model.id ? {} : { reportedContextWindowTokens: undefined }),
            displayName: name.trim(),
            ...(!editing || capabilitiesChanged
              ? {
                  capabilities: {
                    tools,
                    vision,
                    reasoning,
                    ...(reasoning ? { reasoningEffortOptions: efforts } : {}),
                  },
                }
              : {}),
            parameters: {
              ...parameters,
              ...(context ? { contextWindowTokens: Number(context) } : {}),
              ...(maximum ? { maxOutputTokens: Number(maximum) } : {}),
            },
          });
        }}
      >
        <div className="model-editor-grid">
          <label>
            {t("settings.modelEditor.modelID")}
            <Input
              ref={idInput}
              {...invalid("id")}
              aria-label={t("settings.modelEditor.modelID")}
              required
              maxLength={256}
              placeholder={t("settings.modelEditor.modelIDProvidedByTheService")}
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label>
            {t("settings.modelEditor.displayName")}
            <Input
              aria-label={t("settings.modelEditor.displayName")}
              maxLength={128}
              placeholder={t("settings.modelEditor.leaveBlankToUseModelID")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        <section
          className="model-editor-parameters"
          aria-label={t("settings.modelEditor.modelGenerationParameters")}
        >
          <div className="model-editor-grid">
            <label>
              {t("settings.modelEditor.contextLengthInTokens")}
              <Input
                ref={contextInput}
                {...invalid("context")}
                aria-label={t("settings.modelEditor.modelContextTokens")}
                type="number"
                min={1}
                max={2_000_000}
                step={1}
                placeholder={t("settings.modelEditor.providerDefault")}
                value={context}
                onChange={(e) => setContext(e.target.value)}
              />
            </label>
            <label>
              {t("settings.modelEditor.maximumOutputTokens")}
              <Input
                ref={maximumInput}
                {...invalid("maximum")}
                aria-label={t("settings.modelEditor.modelMaximumOutputTokens")}
                type="number"
                min={1}
                step={1}
                placeholder={t("settings.modelEditor.providerDefault")}
                value={maximum}
                onChange={(e) => setMaximum(e.target.value)}
              />
            </label>
          </div>
          <p className="model-editor-inherit-note">
            {t("settings.modelEditor.leaveBlankToUseProviderDefaults")}
          </p>
        </section>
        <section
          className="model-editor-capabilities"
          aria-label={t("settings.modelEditor.modelCapabilities")}
        >
          <div className="model-capability-row">
            <span>{t("settings.modelEditor.toolCalling")}</span>
            <Switch
              aria-label={t("settings.modelEditor.toolCalling")}
              checked={tools}
              onCheckedChange={setTools}
            />
          </div>
          <div className="model-capability-row">
            <span>{t("settings.modelEditor.visionInput")}</span>
            <Switch
              aria-label={t("settings.modelEditor.visionInput")}
              checked={vision}
              onCheckedChange={setVision}
            />
          </div>
          <div className="model-capability-row">
            <span>{t("settings.modelEditor.reasoning")}</span>
            <Switch
              aria-label={t("settings.modelEditor.reasoning")}
              checked={reasoning}
              onCheckedChange={setReasoning}
            />
          </div>
          {reasoning && (
            <div
              className="model-editor-efforts"
              role="group"
              aria-label={t("settings.modelEditor.allowedReasoningEfforts")}
            >
              <span>{t("settings.modelEditor.allowedReasoningEfforts")}</span>
              <div className="model-effort-options">
                {reasoningEfforts.map(([value, label]) => (
                  <label className="model-effort-option" key={value}>
                    <Input
                      type="checkbox"
                      checked={efforts.includes(value)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setEfforts((previous) =>
                          reasoningEfforts
                            .map(([option]) => option)
                            .filter((option) =>
                              option === value ? checked : previous.includes(option),
                            ),
                        );
                      }}
                    />
                    <span>{t(label)}</span>
                  </label>
                ))}
              </div>
              <p>{t("settings.modelEditor.leaveUnselectedToKeepTheAvailableReasoning")}</p>
            </div>
          )}
        </section>
        <Feedback id={errorId} error={error} />
        <p className="settings-muted model-editor-save-note">
          {t("settings.modelEditor.savedToTheProviderDraftTakesEffect")}
        </p>
        <footer>
          <Button type="button" variant="outline" onClick={requestClose}>
            {t("settings.modelEditor.cancel")}
          </Button>
          <Button type="submit">{t("settings.modelEditor.saveModel")}</Button>
        </footer>
      </form>
      {confirmDiscard && (
        <SettingsDialog
          title={t("settings.modelEditor.discardModelChanges")}
          description={t("settings.modelEditor.unsavedModelSettingsWillBeLost")}
          onClose={() => setConfirmDiscard(false)}
        >
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
              {t("settings.modelEditor.keepEditing")}
            </Button>
            <Button variant="destructive" onClick={onClose}>
              {t("settings.modelEditor.discardChanges")}
            </Button>
          </div>
        </SettingsDialog>
      )}
    </SettingsDialog>
  );
}
