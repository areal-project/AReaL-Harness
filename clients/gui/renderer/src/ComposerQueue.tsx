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
import { queueText } from "./Queue.js";
import type { Action, Data } from "./services.js";

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
    const [unknown, setUnknown] = useState<{ requestId: string; operation: string } | null>(() =>
        JSON.parse(localStorage.getItem(operationKey) ?? "null"),
    );
    const [drag, setDrag] = useState<{ id: string; ids: string[]; revision: number } | null>(null);
    const [over, setOver] = useState<string | null>(null);
    const running = thread.turns?.find((turn: Data) => turn.status === "inProgress");
    const locked = disabled || busy || !!editingId || !!unknown;
    const edit = async (operation: string, values: Data = {}, revision = queue.revision) => {
        if (locked) return;
        setBusy(true);
        setError("");
        const unresolved = { requestId: crypto.randomUUID(), operation };
        localStorage.setItem(operationKey, JSON.stringify(unresolved));
        setUnknown(unresolved);
        try {
            await action("queueEdit", {
                projectId: project.id,
                threadId: thread.id,
                expectedRevision: revision,
                requestId: unresolved.requestId,
                operation,
                ...values,
            });
            localStorage.removeItem(operationKey);
            setUnknown(null);
        } catch (cause) {
            const failure = cause as Error & { submissionUnknown?: boolean; requestId?: string };
            if (failure.submissionUnknown && failure.requestId) {
                const unresolved = { requestId: failure.requestId, operation };
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
        setBusy(true);
        try {
            const result = await action("reconcile", { projectId: project.id });
            const known = result.outcomes?.[unknown!.requestId];
            const observed =
                known ??
                (await action("queue", { projectId: project.id, threadId: thread.id, ...unknown }));
            const outcome = known || observed.confirmed ? observed : null;
            if (outcome) {
                localStorage.removeItem(operationKey);
                setUnknown(null);
                setError(
                    outcome.accepted
                        ? "队列操作已确认。"
                        : (outcome.message ?? "操作已被拒绝，请核对当前队列。"),
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
        void edit("reorder", { queueItemIds: ids });
    };
    const drop = (target?: string) => {
        if (drag && target && drag.id !== target && drag.ids.includes(target)) {
            const ids = [...drag.ids],
                from = ids.indexOf(drag.id),
                to = ids.indexOf(target);
            ids.splice(from, 1);
            ids.splice(to, 0, drag.id);
            void edit("reorder", { queueItemIds: ids }, drag.revision);
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
                    <button
                        disabled={busy || !project.state?.connected}
                        onClick={() => void reconcile()}
                    >
                        核对队列操作
                    </button>
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
                        <button disabled={locked} onClick={() => void edit("resume")}>
                            继续队列
                        </button>
                    )}
                </div>
            )}
            {error && (
                <p role="alert" className="composer-queue-feedback">
                    {error}
                </p>
            )}
            {unknown && (
                <button
                    disabled={busy || !project.state?.connected}
                    onClick={() => void reconcile()}
                >
                    核对队列操作
                </button>
            )}
            <div className="composer-queue-rows">
                {items.map((item, index) => (
                    <div
                        key={item.id}
                        data-queue-id={item.id}
                        className={`composer-queue-row${editingId === item.id ? " editing" : ""}${over === item.id ? " drop-target" : ""}`}
                    >
                        <button
                            className="composer-queue-grip"
                            disabled={locked}
                            aria-label={`调整顺序 ${queueText(item)}`}
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
                        </button>
                        <ListEnd size={17} className="composer-queue-glyph" />
                        <span className="composer-queue-copy" title={queueText(item)}>
                            {queueText(item)}
                        </span>
                        {editingId === item.id && <small>编辑中</small>}
                        <div className="composer-queue-actions">
                            <button
                                className="composer-queue-steer"
                                disabled={locked || !running}
                                aria-label={`引导 ${queueText(item)}`}
                                title="现在发送到正在进行的任务"
                                onClick={() =>
                                    void edit("steer", {
                                        queueItemId: item.id,
                                        expectedTurnId: running.id,
                                    })
                                }
                            >
                                <CornerDownRight size={16} />
                                <span>引导</span>
                            </button>
                            <button
                                disabled={locked}
                                aria-label={`删除排队消息 ${queueText(item)}`}
                                title="删除"
                                onClick={() => void edit("remove", { queueItemId: item.id })}
                            >
                                <Trash2 size={17} />
                            </button>
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    render={
                                        <button
                                            disabled={locked}
                                            aria-label={`更多操作 ${queueText(item)}`}
                                        >
                                            <Ellipsis size={18} />
                                        </button>
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
                                    <DropdownMenuItem
                                        disabled={index === 0}
                                        onClick={() => move(item.id, -1)}
                                    >
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
                                        onClick={() => void edit(queue.paused ? "resume" : "pause")}
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
