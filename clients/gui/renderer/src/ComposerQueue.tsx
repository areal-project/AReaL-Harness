import { TitleTooltip } from "@areal/ui";
import { isRequest } from "./services.js";
import { modelRecord } from "./services.js";
import { Button } from "@areal/ui";
import { useState } from "react";
import {
  GripVertical,
  ListEnd,
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
  const queue = project.state?.queues?.[thread.id];
  const items: Data[] = (queue?.items ?? []).filter((item: Data) => item.status === "pending");
  const [busy, setBusy] = useState(false);
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
  const locked = disabled || busy || !!editingId || !!unknown;
  const edit = async (request: QueueEditInput, revision = queue.revision) => {
    if (locked) return;
    setBusy(true);
    setError("");
    const unresolved = { requestId: crypto.randomUUID(), operation: request.operation };
    localStorage.setItem(operationKey, JSON.stringify(unresolved));
    setUnknown(unresolved);
    try {
      await action("queueEdit", {
        projectId: project.id,
        threadId: thread.id,
        expectedRevision: revision,
        requestId: unresolved.requestId,
        ...request,
      });
      localStorage.removeItem(operationKey);
      setUnknown(null);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      if (failure.submissionUnknown && failure.requestId) {
        const unresolved = { requestId: failure.requestId, operation: request.operation };
        localStorage.setItem(operationKey, JSON.stringify(unresolved));
        setUnknown(unresolved);
        setError("队列操作结果尚未确认，条目以 Core 状态为准，不会自动重发。");
      } else {
        localStorage.removeItem(operationKey);
        setUnknown(null);
        setError(failure.message);
      }
    } finally {
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
        setError(
          outcome.status === "failed" || outcome.accepted === false
            ? (outcome.message ?? "队列操作执行失败，请核对当前队列。")
            : "队列操作已确认。",
        );
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
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
  if (!queue || (!items.length && !error && !unknown)) return null;
  if (!items.length)
    return (
      <div className="composer-queue-feedback">
        {error && <p role="alert">{error}</p>}
        {unknown && (
          <Button
            unstyled
            data-slot={undefined}
            type="submit"
            disabled={busy || !project.state?.connected}
            onClick={() => void reconcile()}
          >
            核对队列操作
          </Button>
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
        <p role="alert" className="composer-queue-feedback">
          {error}
        </p>
      )}
      {unknown && (
        <Button
          unstyled
          data-slot={undefined}
          type="submit"
          disabled={busy || !project.state?.connected}
          onClick={() => void reconcile()}
        >
          核对队列操作
        </Button>
      )}
      <div className="composer-queue-rows">
        {items.map((item, index) => (
          <div
            key={item.id}
            data-queue-id={item.id}
            className={`composer-queue-row${editingId === item.id ? " editing" : ""}${over === item.id ? " drop-target" : ""}`}
          >
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
            <ListEnd size={17} className="composer-queue-glyph" />
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
                aria-label={`引导 ${queueLabel(item)}`}
                title="现在发送到正在进行的任务"
                onClick={() =>
                  void edit({
                    operation: "steer",
                    queueItemId: item.id,
                    expectedTurnId: running.id,
                  })
                }
              >
                <CornerDownRight size={16} />
                <span>引导</span>
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
