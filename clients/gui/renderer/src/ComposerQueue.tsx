import { TitleTooltip } from "@areal/ui";
import { errorText } from "./errors/errorCopy.js";
import { isRequest } from "./services.js";
import { modelRecord } from "./services.js";
import { Button } from "@areal/ui";
import { useState } from "react";
import {
  GripVertical,
  CornerDownRight,
  Trash2,
  Ellipsis,
  Pencil,
  ArrowUp,
  ArrowDown,
  Pause,
  Play,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu.js";
import { queueText, type QueueEditInput } from "./Queue.js";
import { imageAnnotationTitle } from "./imageAnnotations.js";
import type { Action, Data } from "./services.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { useAutoReconcile } from "./errors/autoReconcile.js";
import { wasReported } from "./errors/reported.js";
import { recoveredOutcome } from "./recoveryPresentation.js";

const queueLabel = (item: Data) => imageAnnotationTitle(queueText(item));

/** 队列仅展示 Core 投影；排序、删除和引导均等待确认，不先移除本地行。 */
export function ComposerQueue({
  project,
  thread,
  action,
  disabled,
  editingId,
  onEdit,
}: {
  project: Data;
  thread: Data;
  action: Action;
  disabled: boolean;
  editingId?: string;
  onEdit: (item: Data) => void;
}) {
  const { t } = useI18n();
  const queue = project.state?.queues?.[thread.id];
  const items: Data[] = (queue?.items ?? []).filter((item: Data) => item.status === "pending");
  const [busy, setBusy] = useState(false);
  // 原请求还在路上时不核对；答复确实没回来才开始自动核对。
  const [awaiting, setAwaiting] = useState(false);
  const [confirmed, setConfirmed] = useState<{ owner: string; revision: number } | null>(null);
  const [error, setError] = useState("");
  const operationKey = `areal-gui:draft:${project.id}:${thread.id}:queue-operation`;
  const [unknown, setUnknown] = useState<{
    requestId: string;
    operation: QueueEditInput["operation"];
  } | null>(() => {
    const value: unknown = JSON.parse(localStorage.getItem(operationKey) ?? "null");
    if (value === null) return null;
    if (!modelRecord(value)) throw new Error("原队列操作标识无效，请保留记录并核对。");
    const request = { ...value, projectId: project.id, threadId: thread.id };
    if (!isRequest("queue", request) || request.requestId === undefined)
      throw new Error("原队列操作标识无效，请保留记录并核对。");
    return { requestId: request.requestId, operation: request.operation };
  });
  const [drag, setDrag] = useState<{ id: string; ids: string[]; revision: number } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const running = thread.turns?.find((turn: Data) => turn.status === "inProgress");
  const locked =
    disabled ||
    busy ||
    !!editingId ||
    !!unknown ||
    (confirmed?.owner === operationKey && queue?.revision < confirmed.revision);
  const edit = async (request: QueueEditInput, revision = queue.revision) => {
    if (locked) return;
    setBusy(true);
    setError("");
    const unresolved = { requestId: crypto.randomUUID(), operation: request.operation };
    localStorage.setItem(operationKey, JSON.stringify(unresolved));
    setUnknown(unresolved);
    setAwaiting(true);
    try {
      const result = await action("queueEdit", {
        projectId: project.id,
        threadId: thread.id,
        expectedRevision: revision,
        requestId: unresolved.requestId,
        ...request,
      });
      setConfirmed({
        owner: operationKey,
        revision: "revision" in result ? result.revision : result.queueRevision,
      });
      localStorage.removeItem(operationKey);
      setUnknown(null);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      if (failure.submissionUnknown && failure.requestId) {
        const unresolved = { requestId: failure.requestId, operation: request.operation };
        localStorage.setItem(operationKey, JSON.stringify(unresolved));
        setUnknown(unresolved);
      } else {
        localStorage.removeItem(operationKey);
        setUnknown(null);
        if (!wasReported(failure)) setError(errorText(t, failure));
      }
    } finally {
      setAwaiting(false);
      setBusy(false);
    }
  };
  const reconcile = async () => {
    if (!unknown) return;
    setBusy(true);
    try {
      const result = await action("reconcile", { projectId: project.id });
      const request = unknown;
      const known = recoveredOutcome(
        { outcomes: result.outcomes },
        request.requestId,
        thread.id,
        result.outcomes?.[request.requestId]?.operation
          ? {
              requestId: request.requestId,
              method: `areal/queue/${request.operation}`,
              target: { kind: "thread", threadId: thread.id },
            }
          : undefined,
      );
      const observed = known
        ? null
        : await action("queue", { projectId: project.id, threadId: thread.id, ...request });
      const outcome = known ?? (observed?.confirmed ? observed : null);
      if (outcome) {
        localStorage.removeItem(operationKey);
        setUnknown(null);
        if (outcome.status === "failed" || outcome.accepted === false)
          setError(outcome.message ?? "队列操作没有执行，当前显示的是最新队列。");
      }
    } finally {
      setBusy(false);
    }
  };
  useAutoReconcile(
    unknown && !awaiting ? unknown.requestId : null,
    project.state?.connected === true,
    reconcile,
    () => {
      localStorage.removeItem(operationKey);
      setUnknown(null);
      setError(t("recovery.operationUnresolved"));
    },
  );
  const move = (id: string, offset: number) => {
    const ids = items.map((item) => item.id),
      at = ids.indexOf(id);
    if (at < 0 || at + offset < 0 || at + offset >= ids.length) return;
    [ids[at], ids[at + offset]] = [ids[at + offset], ids[at]];
    void edit({ operation: "reorder", queueItemIds: ids });
  };
  const drop = (target?: string) => {
    if (drag && target && drag.id !== target && drag.ids.includes(target)) {
      const ids = [...drag.ids],
        from = ids.indexOf(drag.id),
        to = ids.indexOf(target);
      ids.splice(from, 1);
      ids.splice(to, 0, drag.id);
      void edit({ operation: "reorder", queueItemIds: ids }, drag.revision);
    }
    setDrag(null);
    setOver(null);
  };
  if (!queue || (!items.length && !error)) return null;
  if (!items.length)
    return (
      <div className="composer-queue-feedback">
        {error && (
          <FeedbackNotice transient tone="error" message={error} onDismiss={() => setError("")} />
        )}
      </div>
    );
  return (
    <section className="composer-queue" aria-label="待发送消息">
      {queue.paused && items.length > 0 && (
        <div className="composer-queue-pause">
          <Pause size={12} />
          <span>{editingId ? "编辑期间队列暂停" : "队列已暂停"}</span>
          {!editingId && (
            <Button
              unstyled
              data-slot={undefined}
              type="submit"
              disabled={locked}
              onClick={() => void edit({ operation: "resume" })}
            >
              继续队列
            </Button>
          )}
        </div>
      )}
      {error && (
        <FeedbackNotice transient tone="error" message={error} onDismiss={() => setError("")} />
      )}
      <div className="composer-queue-rows">
        {items.map((item, index) => (
          <div
            key={item.id}
            data-queue-id={item.id}
            className={`composer-queue-row${editingId === item.id ? " editing" : ""}${over === item.id ? " drop-target" : ""}`}
          >
            <span className="composer-queue-handle">
              <span className="composer-queue-index" aria-hidden="true">
                {index + 1}
              </span>
              <Button
                unstyled
                data-slot={undefined}
                type="submit"
                className="composer-queue-grip"
                disabled={locked}
                aria-label={`调整顺序 ${queueLabel(item)}`}
                title="拖动调整顺序，或按上下方向键"
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    move(item.id, event.key === "ArrowUp" ? -1 : 1);
                  }
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDrag({
                    id: item.id,
                    ids: items.map((row) => row.id),
                    revision: queue.revision,
                  });
                }}
                onPointerMove={(event) => {
                  if (!drag) return;
                  const row = document
                    .elementFromPoint(event.clientX, event.clientY)
                    ?.closest<HTMLElement>("[data-queue-id]");
                  setOver(row?.dataset.queueId ?? null);
                }}
                onPointerUp={(event) => {
                  const row = document
                    .elementFromPoint(event.clientX, event.clientY)
                    ?.closest<HTMLElement>("[data-queue-id]");
                  drop(row?.dataset.queueId);
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => {
                  setDrag(null);
                  setOver(null);
                }}
              >
                <GripVertical size={13} />
              </Button>
            </span>
            <TitleTooltip title={queueLabel(item)}>
              <span className="composer-queue-copy">{queueLabel(item)}</span>
            </TitleTooltip>
            {editingId === item.id && <small>编辑中</small>}
            <div className="composer-queue-actions">
              <Button
                unstyled
                data-slot={undefined}
                type="submit"
                className="composer-queue-steer"
                disabled={locked || !running}
                aria-label={t("chat.queue.sendNowItem", { item: queueLabel(item) })}
                title={t("chat.queue.sendNowHint")}
                onClick={() =>
                  void edit({
                    operation: "steer",
                    queueItemId: item.id,
                    expectedTurnId: running.id,
                  })
                }
              >
                <CornerDownRight size={15} />
                <span>{t("chat.queue.sendNow")}</span>
              </Button>
              <Button
                unstyled
                data-slot={undefined}
                type="submit"
                disabled={locked}
                aria-label={`删除排队消息 ${queueLabel(item)}`}
                title="删除"
                onClick={() => void edit({ operation: "remove", queueItemId: item.id })}
              >
                <Trash2 size={17} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      unstyled
                      data-slot={undefined}
                      type="submit"
                      disabled={locked}
                      aria-label={`更多操作 ${queueLabel(item)}`}
                    >
                      <Ellipsis size={18} />
                    </Button>
                  }
                />
                <DropdownMenuContent
                  className="composer-queue-menu"
                  side="top"
                  align="end"
                  aria-label="排队消息操作"
                >
                  <DropdownMenuItem onClick={() => onEdit(item)}>
                    <Pencil size={17} />
                    编辑消息
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={index === 0} onClick={() => move(item.id, -1)}>
                    <ArrowUp size={17} />
                    上移
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === items.length - 1}
                    onClick={() => move(item.id, 1)}
                  >
                    <ArrowDown size={17} />
                    下移
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => void edit({ operation: queue.paused ? "resume" : "pause" })}
                  >
                    {queue.paused ? <Play size={17} /> : <Pause size={17} />}
                    {queue.paused ? "继续队列" : "暂停队列"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
