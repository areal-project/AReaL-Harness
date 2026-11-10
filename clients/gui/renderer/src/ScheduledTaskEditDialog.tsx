import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./components/ui/dialog.js";
import { Input } from "./components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { Switch } from "./components/ui/switch.js";
import { Textarea } from "./components/ui/textarea.js";
import { useI18n, type MessageId } from "./i18n/IntlProvider.js";
import {
  scheduleForm,
  scheduleIntent,
  type Repeat,
  type ScheduleForm,
  type Unit,
} from "./scheduleText.js";
import type { Action, Data } from "./services.js";

const weekdayIds: MessageId[] = [
  "operations.schedules.monday",
  "operations.schedules.tuesday",
  "operations.schedules.wednesday",
  "operations.schedules.thursday",
  "operations.schedules.friday",
  "operations.schedules.saturday",
  "operations.schedules.sunday",
];
const effortIds: Record<string, MessageId> = {
  none: "chat.composer.effort.none",
  minimal: "chat.composer.effort.minimal",
  low: "chat.composer.effort.low",
  medium: "chat.composer.effort.medium",
  high: "chat.composer.effort.high",
  xhigh: "chat.composer.effort.xhigh",
  max: "chat.composer.effort.max",
};
type CatalogModel = {
  providerId: string | null;
  modelId: string;
  displayName: string;
  available: boolean;
  isDefault: boolean;
  parameters?: { reasoningEffort?: string | null };
  reasoningEffortOptions: string[];
};
const modelKey = (model: { providerId: string | null; modelId: string }) =>
  JSON.stringify([model.providerId, model.modelId]);

/** 创建与编辑共用的表单值；model 为 null 表示跟随当前默认模型。 */
export type ScheduledTaskValues = {
  objective: string;
  scheduleV2: NonNullable<ReturnType<typeof scheduleIntent>>;
  delivery: "thread" | "newThread";
  model: { providerId: string; modelId: string } | null;
  reasoningEffort: string | null;
};

/** 定时页新建、编辑任务共用的弹框：默认只露指令、重复、时间，其余收进“高级”。 */
export function ScheduledTaskDialog({
  task,
  initialObjective = "",
  action,
  onClose,
  onSubmit,
}: {
  task?: Data;
  initialObjective?: string;
  action: Action;
  onClose: () => void;
  onSubmit: (values: ScheduledTaskValues, base: Data | undefined) => Promise<void>;
}) {
  const { t } = useI18n();
  const editing = !!task;
  const [form, setForm] = useState<ScheduleForm>(() =>
    task
      ? scheduleForm(task)
      : { ...scheduleForm({}), objective: initialObjective, repeat: "daily" },
  );
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [model, setModel] = useState<string>(() =>
    task?.model ? modelKey(task.model) : "default",
  );
  const [effort, setEffort] = useState<string>(task?.parameters?.reasoningEffort ?? "default");
  const [newThread, setNewThread] = useState(editing && task.delivery !== "thread");
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void action("projectless", { operation: "catalog" })
      .then((value) => {
        if (!live) return;
        const data = ((value as Data)?.models ?? []) as CatalogModel[];
        setModels(data.filter((entry) => entry.available && entry.providerId));
        // 新建时把当前默认模型直接填进来，创建即固定。
        if (!task) {
          const current = data.find((entry) => entry.isDefault && entry.providerId);
          if (current) {
            setModel(modelKey(current));
            setEffort(current.parameters?.reasoningEffort ?? "default");
          }
        }
      })
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [action, task]);
  const selected = models?.find((entry) => modelKey(entry) === model);
  const set = (patch: Partial<ScheduleForm>) => setForm((value) => ({ ...value, ...patch }));
  const save = async () => {
    const objective = form.objective.trim();
    const scheduleV2 = scheduleIntent(form, task ?? {});
    if (!objective || !scheduleV2) {
      setError(t("operations.schedules.invalidEdit"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(
        {
          objective,
          scheduleV2,
          delivery: newThread ? "newThread" : "thread",
          model: selected?.providerId
            ? { providerId: selected.providerId, modelId: selected.modelId }
            : null,
          reasoningEffort: selected && effort !== "default" ? effort : null,
        },
        task,
      );
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const repeatOptions: [Repeat, MessageId][] = [
    ["interval", "operations.schedules.repeatInterval"],
    ["daily", "operations.schedules.repeatDaily"],
    ["weekly", "operations.schedules.repeatWeekly"],
    ["once", "operations.schedules.repeatOnce"],
  ];
  const effortName = (value: string) => (effortIds[value] ? t(effortIds[value]) : value);
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="scheduled-edit max-w-md" data-scheduled-edit={task?.id ?? "new"}>
        <DialogTitle>
          {t(editing ? "operations.schedules.editTitle" : "operations.schedules.newLabel")}
        </DialogTitle>
        <Textarea
          id="scheduled-edit-objective"
          aria-label={t("operations.schedules.objective")}
          placeholder={t("operations.schedules.objectivePlaceholder")}
          value={form.objective}
          rows={5}
          autoFocus={!editing}
          onChange={(event) => set({ objective: event.target.value })}
        />
        <div className="grid gap-2 rounded-control border border-border p-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
            <span id="scheduled-edit-repeat">{t("operations.schedules.repeat")}</span>
            <Select
              value={form.repeat}
              onValueChange={(value) => value && set({ repeat: value as Repeat })}
            >
              <SelectTrigger aria-labelledby="scheduled-edit-repeat">
                <SelectValue>
                  {(value: string) =>
                    t(repeatOptions.find(([key]) => key === value)?.[1] ?? repeatOptions[0][1])
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {repeatOptions.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {t(label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {form.repeat === "interval" && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span id="scheduled-edit-every">{t("operations.schedules.every")}</span>
              <span className="flex flex-wrap items-center gap-1">
                <Input
                  id="scheduled-edit-every-count"
                  className="w-20"
                  aria-labelledby="scheduled-edit-every"
                  type="number"
                  min={1}
                  value={form.every}
                  onChange={(event) => set({ every: Number(event.target.value) })}
                />
                <Select
                  value={form.unit}
                  onValueChange={(value) => value && set({ unit: value as Unit })}
                >
                  <SelectTrigger aria-label={t("operations.schedules.every")}>
                    <SelectValue>
                      {(value: string) =>
                        t(
                          value === "hours"
                            ? "operations.schedules.hoursUnit"
                            : "operations.schedules.minutesUnit",
                        )
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">{t("operations.schedules.minutesUnit")}</SelectItem>
                    <SelectItem value="hours">{t("operations.schedules.hoursUnit")}</SelectItem>
                  </SelectContent>
                </Select>
              </span>
            </div>
          )}
          {form.repeat === "weekly" && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 text-ui-sm"
              role="group"
              aria-label={t("operations.schedules.onDays")}
            >
              <span>{t("operations.schedules.onDays")}</span>
              <span className="flex flex-wrap items-center gap-1">
                {weekdayIds.map((id, index) => {
                  const day = index + 1;
                  const on = form.weekdays.includes(day);
                  return (
                    <Button
                      key={id}
                      size="xs"
                      variant={on ? "secondary" : "ghost"}
                      aria-pressed={on}
                      onClick={() =>
                        set({
                          weekdays: on
                            ? form.weekdays.filter((value) => value !== day)
                            : [...form.weekdays, day],
                        })
                      }
                    >
                      {t(id)}
                    </Button>
                  );
                })}
              </span>
            </div>
          )}
          {(form.repeat === "daily" || form.repeat === "weekly") && (
            <label className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span>{t("operations.schedules.at")}</span>
              <Input
                id="scheduled-edit-time"
                type="time"
                value={form.time}
                onChange={(event) => set({ time: event.target.value })}
              />
            </label>
          )}
          {form.repeat === "once" && (
            <label className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span>{t("operations.schedules.date")}</span>
              <Input
                id="scheduled-edit-at"
                type="datetime-local"
                value={form.at}
                onChange={(event) => set({ at: event.target.value })}
              />
            </label>
          )}
        </div>
        <div>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={advanced}
            aria-controls="scheduled-edit-advanced"
            onClick={() => setAdvanced(!advanced)}
          >
            {t("operations.schedules.advanced")}
          </Button>
        </div>
        {advanced && (
          <div
            id="scheduled-edit-advanced"
            className="grid gap-2 rounded-control border border-border p-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span id="scheduled-edit-model">{t("operations.schedules.model")}</span>
              <Select
                value={model}
                disabled={models === null}
                onValueChange={(value) => {
                  if (!value) return;
                  setModel(value);
                  setEffort("default");
                }}
              >
                <SelectTrigger aria-labelledby="scheduled-edit-model">
                  <SelectValue>
                    {(value: string) =>
                      models?.find((entry) => modelKey(entry) === value)?.displayName ??
                      t("operations.schedules.modelDefault")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t("operations.schedules.modelDefault")}</SelectItem>
                  {(models ?? []).map((entry) => (
                    <SelectItem key={modelKey(entry)} value={modelKey(entry)}>
                      {entry.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!!selected?.reasoningEffortOptions.length && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
                <span id="scheduled-edit-effort">{t("operations.schedules.effort")}</span>
                <Select value={effort} onValueChange={(value) => value && setEffort(value)}>
                  <SelectTrigger aria-labelledby="scheduled-edit-effort">
                    <SelectValue>
                      {(value: string) =>
                        value === "default" ? t("chat.composer.serviceDefault") : effortName(value)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t("chat.composer.serviceDefault")}</SelectItem>
                    {selected.reasoningEffortOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {effortName(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <label className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span>{t("operations.schedules.newThreadEachRun")}</span>
              <Switch checked={newThread} onCheckedChange={setNewThread} />
            </label>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("operations.schedules.cancelEdit")}
          </Button>
          <Button disabled={saving || !form.objective.trim()} onClick={() => void save()}>
            {saving
              ? t("operations.schedules.saving")
              : t(editing ? "operations.schedules.save" : "operations.schedules.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 编辑已有任务：只提交改动过的字段，版本冲突时载入最新内容让用户重试。 */
export function ScheduledTaskEditDialog({
  task,
  project,
  action,
  onClose,
  onChanged,
}: {
  task: Data;
  project: Data;
  action: Action;
  onClose: () => void;
  onChanged?: (task: Data) => void;
}) {
  const { t } = useI18n();
  const [base, setBase] = useState(task);
  return (
    <ScheduledTaskDialog
      key={base.revision}
      task={base}
      action={action}
      onClose={onClose}
      onSubmit={async (values) => {
        const modelChanged =
          JSON.stringify(values.model) !==
            JSON.stringify(
              base.model
                ? { providerId: base.model.providerId, modelId: base.model.modelId }
                : null,
            ) || (values.reasoningEffort ?? null) !== (base.parameters?.reasoningEffort ?? null);
        try {
          const result = await action("manage", {
            projectId: project.id,
            operation: "taskUpdate",
            taskId: base.id,
            expectedRevision: base.revision,
            ...(values.objective !== base.objective ? { objective: values.objective } : {}),
            scheduleV2: values.scheduleV2,
            ...(values.delivery !== (base.delivery ?? "newThread")
              ? { delivery: values.delivery }
              : {}),
            ...(modelChanged && values.model
              ? {
                  model: values.model,
                  parameters: modelParameters(values.reasoningEffort),
                }
              : {}),
          });
          if (result && "id" in result && result.id === base.id) onChanged?.(result as Data);
          window.dispatchEvent(
            new CustomEvent("areal-scheduled-tasks-changed", { detail: project.id }),
          );
        } catch (cause) {
          const latest = await action("manage", {
            projectId: project.id,
            operation: "task",
            taskId: base.id,
          }).catch(() => null);
          if (latest && latest.revision !== base.revision) {
            setBase(latest);
            throw new Error(t("operations.schedules.conflict"));
          }
          throw cause;
        }
      }}
    />
  );
}

/** Core 的 ModelParameters 要求列出可空字段；只固定推理强度。 */
export function modelParameters(reasoningEffort: string | null) {
  return { temperature: null, maxOutputTokens: null, reasoningEffort };
}
