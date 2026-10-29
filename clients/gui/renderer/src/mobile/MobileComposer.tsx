import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@areal/ui";
import { Dialog, DialogContent, DialogTitle } from "@areal/ui";
import { ConversationComposer } from "../ConversationComposer.js";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Shield, ShieldAlert } from "lucide-react";
import { AskPermissionIcon, AutoPermissionIcon } from "../permissionIcons.js";
import { ComposerQueue } from "../ComposerQueue.js";
import { SendMessageIcon, StopIcon } from "../interfaceIcons.js";
import {
  permissionChoices,
  permissionMode,
  permissionOptions,
  type PermissionMode,
} from "../permissions.js";
import { useI18n, type MessageId } from "../i18n/IntlProvider.js";
import type { Data, Action } from "../services.js";
import type { LexicalChatInputHandle } from "../LexicalChatInput.js";
import type { MobileClient } from "./mobile-client.mjs";
import type { MobileWorkspace } from "./mobile-workspace.mjs";
import type { MobileCommands } from "./mobile-commands.mjs";

const errors: Record<string, MessageId> = {
  DEVICE_SAVE_FAILED: "mobile.deviceSaveBeforeSend",
  LOCAL_NOT_SENT: "mobile.notSent",
  CONFIGURATION_UNAVAILABLE: "mobile.configurationUnavailable",
  UNSUPPORTED_PROFILE: "mobile.unsupportedProfile",
  TASK_CONTROL_REQUIRED: "mobile.taskControlRequired",
  SUBMISSION_UNKNOWN: "mobile.commandUnknown",
  RECOVERY_FAILED: "mobile.commandRecoveryFailed",
};
const effortLabels: Record<string, MessageId> = {
  none: "mobile.effort.none",
  minimal: "mobile.effort.minimal",
  low: "mobile.effort.low",
  medium: "mobile.effort.medium",
  high: "mobile.effort.high",
  xhigh: "mobile.effort.xhigh",
  max: "mobile.effort.max",
};
export function MobileComposer({
  client,
  workspace,
  commands,
}: {
  client: MobileClient;
  workspace: MobileWorkspace;
  commands: MobileCommands;
}) {
  const { t } = useI18n();
  const view = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const command = useSyncExternalStore(commands.subscribe, commands.snapshot);
  const connection = useSyncExternalStore(client.subscribe, client.snapshot);
  const input = useRef<LexicalChatInputHandle | null>(null);
  const [sheet, setSheet] = useState<Data | null>(null);
  const [panel, setPanel] = useState<"model" | "permissions">("model");
  const [modelView, setModelView] = useState<"quick" | "advanced" | "models" | "effort">("quick");
  const page = view.page;
  const projectId = page.kind === "projects" ? "" : page.projectId;
  const threadId = page.kind === "session" ? page.threadId : "";
  const draft = commands.draft(projectId, threadId);
  useEffect(() => {
    if (input.current && input.current.getMarkdown() !== draft) input.current.setText(draft);
  }, [draft, projectId, threadId]);
  if (!["new", "session"].includes(page.kind)) return null;
  const isNew = page.kind === "new";
  const snapshot = view.detail?.snapshot;
  const config = snapshot?.configuration;
  const catalog: Data[] = (isNew ? view.catalog?.models : snapshot?.models) ?? [];
  const models = catalog.filter(
    (item) =>
      item.providerId || !catalog.some((candidate) => candidate.providerId && candidate.isDefault),
  );
  const intent = commands.intent(projectId, threadId);
  const pending = commands.unresolved(projectId, threadId);
  const running = !!snapshot?.activeTurnId;
  const connected = connection.kind === "connected";
  const canSubmit = connected && connection.ready.capabilities.includes("submit");
  const canInterrupt = connected && connection.ready.capabilities.includes("interrupt");
  const ordinary = isNew || snapshot?.ownership.kind === "ordinary";
  const blocked = commands.blocksSend(projectId, threadId);
  const disabled =
    !canSubmit || !ordinary || command.recovering || (isNew ? !view.catalog : !snapshot);
  const model = intent && "model" in intent ? intent.model : config?.model;
  const modelName =
    models.find(
      (value) => value.providerId === model?.providerId && value.modelId === model?.modelId,
    )?.displayName ??
    model?.modelId ??
    t("mobile.computerDefault");
  const project: Data = {
    id: projectId,
    root: "",
    models,
    pending: [],
    core: { features: {} },
    state: {
      connected: canSubmit,
      queues: { [threadId]: snapshot?.queue },
      interactions: {},
      threads: {},
    },
  };
  const thread: Data = { id: threadId, turns: [], desktop: { archived: false } };
  const queueAction = (async () => {
    throw new Error(t("mobile.queueDesktop"));
  }) as Action;
  const choose = (next: "model" | "permissions") => {
    setPanel(next);
    setModelView("quick");
    setSheet(structuredClone(intent ?? {}));
  };
  const sheetModel = sheet && "model" in sheet ? sheet.model : config?.model;
  const selectedModel =
    models.find(
      (value) =>
        value.providerId === sheetModel?.providerId && value.modelId === sheetModel?.modelId,
    ) ??
    models.find((value) => value.isDefault) ??
    models.find((value) => !value.providerId);
  const selectedEffort =
    sheet?.parameters?.reasoningEffort !== undefined
      ? sheet.parameters.reasoningEffort
      : (config?.resolvedParameters?.reasoningEffort ?? config?.parameters?.reasoningEffort);
  const visibleEfforts: string[] = selectedModel?.reasoningEffortOptions ?? [];
  const selectedPermission = (options: Data | undefined): PermissionMode => {
    if (
      config?.profile?.readOnly ||
      (options?.readOnly ?? config?.options?.readOnly ?? config?.readOnly)
    )
      return "readOnly";
    return options?.permissionPreset ?? permissionMode(config ?? {});
  };
  const permissionLabel = (value: PermissionMode) =>
    isNew && value === "auto" ? t("mobile.computerPermissions") : t(`chat.permissions.${value}`);
  const currentPermission = selectedPermission(intent?.options);
  const currentEffort =
    intent?.parameters?.reasoningEffort ??
    config?.resolvedParameters?.reasoningEffort ??
    config?.parameters?.reasoningEffort;
  const save = async () => {
    if (!sheet) return;
    if (!Object.keys(sheet).length || (await commands.configure(projectId, threadId, sheet)))
      setSheet(null);
  };
  const stopPending = pending.some(
    (value) =>
      value.method === "turn.stop" && value.params.expectedTurnId === snapshot?.activeTurnId,
  );
  return (
    <>
      <div
        className="mobile-composer p-0! max-w-none! w-full [&_.composer-primary-action]:min-w-[var(--size-touch-target)] [&_.composer-primary-action]:min-h-[var(--size-touch-target)] [&_[data-composer-leading-actions]]:flex-[0_1_auto]! [&_[data-composer-leading-actions]]:max-w-[45%] [&_[data-composer-trailing-actions]]:flex-1! [&_[data-composer-trailing-actions]]:min-w-0 [&_.composer-editor]:rounded-none [&_.composer-editor]:shadow-none flex-[0_0_auto] min-w-0 composer-dock"
        data-field="composer"
        data-config-revision={snapshot?.configRevision}
        data-active-turn={snapshot?.activeTurnId ?? ""}
      >
        {command.error && <p role="alert">{t(errors[command.error] ?? "mobile.commandFailed")}</p>}
        {pending.map((value) => (
          <div
            className="mobile-command-notice flex items-center gap-inline"
            key={value.commandId}
            data-command-state={value.admissionState}
            data-command-id={value.commandId}
          >
            <p role="status">
              {t(
                value.admissionState === "pending"
                  ? "mobile.commandPending"
                  : "mobile.commandUnknown",
              )}
            </p>
            {value.admissionState !== "pending" && (
              <Button
                className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                variant="outline"
                data-action="query-command"
                disabled={!connected || command.recovering}
                onClick={() => void commands.query(value)}
              >
                {t("mobile.queryCommand")}
              </Button>
            )}
          </div>
        ))}
        {!isNew && snapshot?.queue && (
          <ComposerQueue
            project={project}
            thread={thread}
            action={queueAction}
            disabled
            onEdit={() => {}}
          />
        )}
        <ConversationComposer
          project={project}
          touchInput
          modelConfig={config}
          onConfigureModel={() => {}}
          modelControl={
            <Button
              variant="ghost"
              className="mobile-composer-chip h-auto min-h-[var(--size-touch-target)] min-w-0 max-w-full py-[calc(var(--spacing-inline)/2)] px-inline gap-[calc(var(--spacing-inline)/2)] shrink [&_span]:min-w-0 [&_span]:truncate [&_svg]:size-[var(--activity-chevron-size)]! text-fixed-caption text-foreground-subtle"
              data-action="model-sheet"
              disabled={disabled || command.busy || blocked}
              onClick={() => choose("model")}
            >
              <span>
                {modelName}
                {currentEffort && effortLabels[currentEffort]
                  ? ` · ${t(effortLabels[currentEffort])}`
                  : ""}
              </span>
              <ChevronDown />
            </Button>
          }
          leadingActions={
            <Button
              variant="ghost"
              className="mobile-composer-chip h-auto min-h-[var(--size-touch-target)] min-w-0 max-w-full py-[calc(var(--spacing-inline)/2)] px-inline gap-[calc(var(--spacing-inline)/2)] shrink [&_span]:min-w-0 [&_span]:truncate [&_svg]:size-[var(--activity-chevron-size)]! text-fixed-caption text-foreground-subtle"
              data-action="permission-sheet"
              aria-label={t("mobile.permissions")}
              disabled={disabled || command.busy || blocked}
              onClick={() => choose("permissions")}
            >
              {currentPermission === "ask" ? <AskPermissionIcon /> : <AutoPermissionIcon />}
              <span>{permissionLabel(currentPermission)}</span>
            </Button>
          }
          workspacePath=""
          taskId={threadId || null}
          inputApiRef={input}
          inputTestId="mobile-chat-input"
          submitTestId="mobile-chat-send"
          initialValue={draft}
          placeholder={t(
            isNew
              ? "mobile.newMessagePlaceholder"
              : running
                ? "mobile.queuePlaceholder"
                : "mobile.messagePlaceholder",
          )}
          disabled={!canSubmit || !ordinary}
          submitDisabled={disabled || blocked || command.busy || !draft.trim()}
          submitLabel={t(running ? "mobile.enqueue" : "mobile.send")}
          enterSubmits={false}
          showMentionButton={false}
          showSlashButton={false}
          enableMentionPanel={false}
          enableWorkspaceFileDrop={false}
          enableExternalFileDrop={false}
          onChange={(text) => commands.setDraft(projectId, threadId, text)}
          onSubmit={() => {
            void commands.send();
            return false;
          }}
          onCancel={running && canInterrupt ? () => void commands.stop() : undefined}
          submitControl={
            running && !draft.trim() ? (
              <Button
                className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] composer-primary-action [border-radius:var(--radius-pill)] composer-stop-action"
                size="icon"
                variant="secondary"
                aria-label={t("mobile.stop")}
                data-action="stop"
                disabled={!canInterrupt || command.busy || stopPending}
                onClick={() => void commands.stop()}
              >
                <StopIcon />
              </Button>
            ) : (
              <Button
                className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] composer-primary-action [border-radius:var(--radius-pill)]"
                size="icon"
                aria-label={t(running ? "mobile.enqueue" : "mobile.send")}
                data-testid="mobile-chat-send"
                data-action="send"
                disabled={disabled || blocked || command.busy || !draft.trim()}
                onClick={() => void commands.send()}
              >
                <SendMessageIcon />
              </Button>
            )
          }
        />
      </div>
      <Dialog
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      >
        <DialogContent
          className="mobile-model-sheet [&_h2]:[line-height:1.3] [&_h2]:font-semibold [&_h3]:[line-height:1.3] [&_h3]:font-semibold border-0 [border-radius:var(--radius-overlay)_var(--radius-overlay)_0_0] shadow-none [transition:translate_var(--motion-normal)_var(--ease-standard)]"
          data-panel={panel}
          data-view={modelView}
          overlayClassName="mobile-sheet-overlay bg-dialog-backdrop supports-backdrop-filter:backdrop-blur-none"
          closeLabel={t("mobile.cancel")}
          showCloseButton={false}
        >
          <div
            className="mobile-sheet-handle shrink-0 self-center my-inline w-[calc(var(--spacing-section)+var(--spacing-inline))] h-[calc(var(--spacing-inline)/2)] bg-border [border-radius:var(--radius-pill)]"
            aria-hidden="true"
          />
          <div className="mobile-sheet-header flex items-center justify-between gap-inline min-h-[var(--size-touch-target)] shrink-0 mb-field [&_h2]:flex-1 [&_h2]:text-fixed-emphasis [&_h2]:text-center">
            {panel === "model" && modelView !== "quick" && (
              <Button
                variant="ghost"
                size="icon"
                className="mobile-sheet-back min-w-[var(--size-touch-target)] min-h-[var(--size-touch-target)]"
                aria-label={t("mobile.back")}
                onClick={() => setModelView(modelView === "advanced" ? "quick" : "advanced")}
              >
                <ChevronLeft />
              </Button>
            )}
            <DialogTitle>
              {panel === "permissions"
                ? t("chat.permissions.choose")
                : modelView === "models"
                  ? t("mobile.models")
                  : modelView === "effort"
                    ? t("mobile.reasoning")
                    : modelView === "quick"
                      ? t("mobile.models")
                      : t("mobile.modelAdvanced")}
            </DialogTitle>
            <Button
              variant="ghost"
              className="mobile-sheet-done h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] p-0 text-fixed-body font-semibold"
              data-action="model-done"
              disabled={command.busy || (running && !!Object.keys(sheet ?? {}).length)}
              onClick={() => void save()}
            >
              {t("mobile.done")}
            </Button>
          </div>
          <div className="mobile-sheet-scroll overflow-y-auto min-h-0 flex flex-col gap-section">
            {panel === "model" && (
              <>
                {isNew && view.catalog?.unsupported && (
                  <p role="status">{t("mobile.modelsUpgrade")}</p>
                )}
                {modelView === "quick" && (
                  <Button
                    variant="ghost"
                    className="mobile-model-summary w-full h-auto min-h-[var(--size-touch-target)] gap-inline [&>span]:min-w-0 text-fixed-section-title! justify-center"
                    data-action="model-advanced"
                    onClick={() => setModelView("advanced")}
                  >
                    <span className="truncate">{selectedModel?.displayName || modelName}</span>
                    <span className="text-foreground-subtle">
                      {selectedEffort && effortLabels[selectedEffort]
                        ? t(effortLabels[selectedEffort])
                        : t("chat.composer.serviceDefault")}
                    </span>
                    <ChevronRight />
                  </Button>
                )}
                {modelView === "advanced" && (
                  <div className="mobile-choice-group overflow-hidden rounded-[var(--radius-card)] bg-hover">
                    <Button
                      variant="ghost"
                      className="mobile-setting-row flex w-full h-auto min-h-[var(--size-touch-target)] p-field gap-inline justify-start [&_svg]:size-[var(--spacing-field)]! text-fixed-emphasis! [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border"
                      data-action="model-list"
                      onClick={() => setModelView("models")}
                    >
                      <span>{t("mobile.models")}</span>
                      <span className="mobile-setting-value ml-auto min-w-0 truncate">
                        {selectedModel?.displayName || modelName}
                      </span>
                      <ChevronDown />
                    </Button>
                    {selectedModel?.capabilities?.reasoning !== false &&
                      visibleEfforts.length > 0 && (
                        <Button
                          variant="ghost"
                          className="mobile-setting-row flex w-full h-auto min-h-[var(--size-touch-target)] p-field gap-inline justify-start [&_svg]:size-[var(--spacing-field)]! text-fixed-emphasis! [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border"
                          data-action="effort-list"
                          onClick={() => setModelView("effort")}
                        >
                          <span>{t("mobile.reasoning")}</span>
                          <span className="mobile-setting-value ml-auto min-w-0">
                            {selectedEffort && effortLabels[selectedEffort]
                              ? t(effortLabels[selectedEffort])
                              : t("chat.composer.serviceDefault")}
                          </span>
                          <ChevronDown />
                        </Button>
                      )}
                  </div>
                )}
                {modelView === "models" && (
                  <RadioGroup
                    className="mobile-choice-group overflow-hidden rounded-[var(--radius-card)] bg-hover"
                    aria-label={t("mobile.models")}
                    value={
                      selectedModel
                        ? `${selectedModel.providerId ?? ""}/${selectedModel.modelId}`
                        : ""
                    }
                    onValueChange={(key) => {
                      const value = models.find(
                        (item) => `${item.providerId ?? ""}/${item.modelId}` === key,
                      );
                      if (value) {
                        setSheet({
                          ...sheet,
                          model: value.providerId
                            ? { providerId: value.providerId, modelId: value.modelId }
                            : null,
                        });
                        setModelView("advanced");
                      }
                    }}
                  >
                    {models.map((value) => (
                      <Radio.Root
                        key={`${value.providerId}/${value.modelId}`}
                        value={`${value.providerId ?? ""}/${value.modelId}`}
                        className="mobile-model-choice mobile-choice-row flex items-center w-full min-h-[var(--size-touch-target)] h-auto p-field gap-inline text-start [&>span:first-child]:flex-1 [&>span:first-child]:min-w-0 border-0 [border-bottom:var(--border-width-default)_solid_var(--color-border)] bg-transparent text-foreground [font-family:inherit] text-fixed-body [line-height:1.4] cursor-pointer [&:last-child]:[border-bottom:0] [&_small]:text-fixed-caption [&_small]:text-foreground-subtle [&[data-disabled]]:opacity-50 [&[data-disabled]]:cursor-default [&:focus-visible]:[outline:var(--focus-width)_solid_var(--color-ring)] [&:focus-visible]:[outline-offset:calc(-1_*_var(--focus-width))]"
                        data-model-id={value.modelId}
                        disabled={running || command.busy || value.available === false}
                      >
                        <span className="mobile-choice-copy flex flex-col [&_>_span]:font-semibold">
                          <span>{value.displayName || value.modelId}</span>
                          {(value.isDefault || !value.providerId) && (
                            <small>{t("mobile.computerDefault")}</small>
                          )}
                          {value.available === false && (
                            <small>{t("mobile.modelUnavailable")}</small>
                          )}
                        </span>
                        <Radio.Indicator className="mobile-choice-check inline-flex ml-auto [&_svg]:size-[var(--spacing-field)] text-brand">
                          <Check />
                        </Radio.Indicator>
                      </Radio.Root>
                    ))}
                  </RadioGroup>
                )}
                {["quick", "effort"].includes(modelView) &&
                  selectedModel?.capabilities?.reasoning !== false &&
                  visibleEfforts.length > 0 && (
                    <RadioGroup
                      className="mobile-efforts grid grid-flow-col auto-cols-fr p-[calc(var(--spacing-inline)/2)] gap-[calc(var(--spacing-inline)/2)] rounded-[var(--radius-pill)] bg-hover"
                      aria-label={t("mobile.reasoning")}
                      value={selectedEffort ?? "default"}
                      onValueChange={(value) =>
                        setSheet({
                          ...sheet,
                          parameters: { ...sheet?.parameters, reasoningEffort: value },
                        })
                      }
                    >
                      {visibleEfforts.map((value: string) => (
                        <Radio.Root
                          key={value}
                          value={value}
                          aria-label={effortLabels[value] ? t(effortLabels[value]) : value}
                          className="mobile-effort-choice grid place-items-center min-h-[var(--size-touch-target)] py-[calc(var(--spacing-inline)/2)] px-0 whitespace-nowrap [&[data-checked]_.mobile-effort-dot]:size-[calc(var(--size-touch-target)-var(--spacing-inline))] rounded-[var(--radius-pill)] border-0 bg-transparent text-foreground-subtle text-fixed-caption [&[data-checked]]:bg-brand [&[data-checked]_.mobile-effort-dot]:bg-control-thumb [&:focus-visible]:ring-2 [&:focus-visible]:ring-ring"
                          disabled={running || command.busy}
                        >
                          <span
                            className="mobile-effort-dot size-inline rounded-[var(--radius-pill)] bg-current"
                            aria-hidden="true"
                          />
                          <span className="sr-only">
                            {effortLabels[value] ? t(effortLabels[value]) : value}
                          </span>
                        </Radio.Root>
                      ))}
                    </RadioGroup>
                  )}
              </>
            )}
            {panel === "permissions" && (
              <>
                <p className="mobile-permission-question m-0 text-fixed-emphasis text-center">
                  {t("mobile.permissionQuestion")}
                </p>
                <RadioGroup
                  className="mobile-choice-group overflow-hidden rounded-[var(--radius-overlay)] bg-hover"
                  aria-label={t("mobile.permissions")}
                  value={selectedPermission(sheet?.options)}
                  onValueChange={(mode) =>
                    setSheet({
                      ...sheet,
                      options: permissionOptions(
                        mode as "ask" | "autoReview" | "fullAccess",
                        sheet?.options ?? intent?.options ?? config?.options,
                      ),
                    })
                  }
                >
                  {permissionChoices.map((option) => (
                    <Radio.Root
                      key={option.id}
                      value={option.id}
                      className={`mobile-permission-choice gap-field [&>svg]:shrink-0 [&>svg]:size-section [&>.mobile-choice-copy]:flex-1 [&>.mobile-choice-copy]:min-w-0 mobile-choice-row flex items-center w-full min-h-[var(--size-touch-target)] h-auto p-field gap-inline text-start [&>span:first-child]:flex-1 [&>span:first-child]:min-w-0 border-0 [border-bottom:var(--border-width-default)_solid_var(--color-border)] bg-transparent text-foreground [font-family:inherit] text-fixed-body [line-height:1.4] cursor-pointer [&:last-child]:[border-bottom:0] [&_small]:text-fixed-caption [&_small]:text-foreground-subtle [&[data-disabled]]:opacity-50 [&[data-disabled]]:cursor-default [&:focus-visible]:[outline:var(--focus-width)_solid_var(--color-ring)] [&:focus-visible]:[outline-offset:calc(-1_*_var(--focus-width))] ${option.id === "fullAccess" ? "text-status-attention! [&_small]:text-status-attention!" : ""}`}
                      data-permission-preset={option.id}
                      disabled={
                        running ||
                        command.busy ||
                        (!isNew && (!config?.permissions || config?.profile?.readOnly)) ||
                        (option.id === "fullAccess" &&
                          !isNew &&
                          !config?.permissions?.fullAccessAvailable)
                      }
                    >
                      {option.id === "ask" ? (
                        <AskPermissionIcon />
                      ) : option.id === "fullAccess" ? (
                        <ShieldAlert />
                      ) : (
                        <AutoPermissionIcon />
                      )}
                      <span className="mobile-choice-copy flex flex-col">
                        <span className="text-fixed-emphasis">{t(option.labelId)}</span>
                        <small>{t(option.descriptionId)}</small>
                      </span>
                      <Radio.Indicator className="mobile-choice-check inline-flex ml-auto [&_svg]:size-[var(--spacing-field)] text-foreground">
                        <Check />
                      </Radio.Indicator>
                    </Radio.Root>
                  ))}
                  {!permissionChoices.some(
                    (option) => option.id === selectedPermission(sheet?.options),
                  ) && (
                    <Radio.Root
                      value={selectedPermission(sheet?.options)}
                      className="mobile-permission-choice gap-field [&>svg]:shrink-0 [&>svg]:size-section [&>.mobile-choice-copy]:flex-1 [&>.mobile-choice-copy]:min-w-0 mobile-choice-row flex items-center w-full min-h-[var(--size-touch-target)] h-auto p-field gap-inline text-start [&>span:first-child]:flex-1 [&>span:first-child]:min-w-0 border-0 [border-bottom:var(--border-width-default)_solid_var(--color-border)] bg-transparent text-foreground [font-family:inherit] text-fixed-body [line-height:1.4] cursor-pointer [&:last-child]:[border-bottom:0] [&_small]:text-fixed-caption [&_small]:text-foreground-subtle [&[data-disabled]]:opacity-50 [&[data-disabled]]:cursor-default [&:focus-visible]:[outline:var(--focus-width)_solid_var(--color-ring)] [&:focus-visible]:[outline-offset:calc(-1_*_var(--focus-width))]"
                      disabled
                    >
                      <Shield />
                      <span>{permissionLabel(selectedPermission(sheet?.options))}</span>
                      <Radio.Indicator className="mobile-choice-check inline-flex ml-auto [&_svg]:size-[var(--spacing-field)]">
                        <Check />
                      </Radio.Indicator>
                    </Radio.Root>
                  )}
                </RadioGroup>
              </>
            )}
            <p className="mobile-sheet-note m-0 text-fixed-caption leading-normal text-foreground-subtle">
              {t("mobile.configureAfterTurn")} {t("mobile.applyOnSend")}
            </p>
            {intent && command.error && (
              <Button
                variant="ghost"
                onClick={() => {
                  commands.setIntent(projectId, threadId, undefined);
                  setSheet({});
                }}
              >
                {t("mobile.resetIntent")}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
