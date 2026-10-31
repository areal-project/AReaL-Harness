import { useState } from "react";
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
  const [form, setForm] = useState(() => scheduleForm(task));
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const set = (patch: Partial<ScheduleForm>) => setForm((value) => ({ ...value, ...patch }));
  const save = async () => {
    const objective = form.objective.trim();
    const scheduleV2 = scheduleIntent(form, base);
    if (!objective || !scheduleV2) {
      setError(t("operations.schedules.invalidEdit"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await action("manage", {
        projectId: project.id,
        operation: "taskUpdate",
        taskId: base.id,
        expectedRevision: base.revision,
        ...(objective !== base.objective ? { objective } : {}),
        scheduleV2,
      });
      if (result && "id" in result && result.id === base.id) onChanged?.(result as Data);
      window.dispatchEvent(
        new CustomEvent("areal-scheduled-tasks-changed", { detail: project.id }),
      );
      onClose();
    } catch (cause) {
      const latest = await action("manage", {
        projectId: project.id,
        operation: "task",
        taskId: base.id,
      }).catch(() => null);
      if (latest && latest.revision !== base.revision) {
        setBase(latest);
        setForm(scheduleForm(latest));
        setError(t("operations.schedules.conflict"));
      } else setError((cause as Error).message);
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
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="scheduled-edit max-w-md" data-scheduled-edit={task.id}>
        <DialogTitle>{t("operations.schedules.editTitle")}</DialogTitle>
        <label className="flex flex-col gap-1 text-ui-sm">
          <span>{t("operations.schedules.objective")}</span>
          <Textarea
            id="scheduled-edit-objective"
            value={form.objective}
            rows={5}
            onChange={(event) => set({ objective: event.target.value })}
          />
        </label>
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
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("operations.schedules.cancelEdit")}
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? t("operations.schedules.saving") : t("operations.schedules.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
