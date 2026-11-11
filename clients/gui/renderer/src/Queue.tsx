import { Button, Textarea } from "@areal/ui";
import { currentErrorText } from "./errors/currentErrorText.js";
import { useState } from "react";
import { useI18n } from "./i18n/IntlProvider.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { wasReported } from "./errors/reported.js";
import type { Data, Action, CommandParams } from "./services.js";

export type QueueEditInput = {
  [Request in CommandParams<"queueEdit"> as Request["operation"]]: Omit<
    Request,
    "projectId" | "threadId" | "expectedRevision" | "requestId"
  >;
}[CommandParams<"queueEdit">["operation"]];

export const queueText = (item: Data) =>
  (item.input ?? []).map((p: Data) => (p.type === "text" ? p.text : "[附件]")).join("\n");

const statusLabel: Record<string, string> = {
  pending: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  removed: "已移除",
  interrupted: "已停止",
};

const blockedBecause: Record<string, string> = {
  running: "已经开始执行",
  completed: "已经执行完成",
  failed: "已经失败",
  removed: "已经移除",
  interrupted: "已经停止",
};

export type QueueDraft = { id: string; text: string; revision: number };

// 编辑从打开时看到的 revision 提交。队列随后变化时，继续用旧 revision，
// 让 Core 拒绝覆盖；未提交文字留在编辑框里。
export function queueEditRefusal(
  queue: Data,
  draft: { id?: string; revision: number } | null,
  fallback = "",
): string {
  if (!draft?.id) return fallback;
  const item = (queue.items ?? []).find((entry: Data) => entry.id === draft.id);
  if (item && item.status !== "pending") {
    return `这条消息${blockedBecause[item.status] ?? `当前是${item.status}`}，不能再编辑。未提交的内容已保留。`;
  }
  if (queue.revision !== draft.revision) {
    return "队列已有更新，这次修改没有覆盖较新内容。未提交的内容已保留。";
  }
  return fallback;
}

export function Queue({
  queue,
  projectId,
  threadId,
  disabled,
  action,
}: {
  queue: Data;
  projectId: string;
  threadId: string;
  disabled: boolean;
  action: Action;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<QueueDraft | null>(null);
  const [error, setError] = useState("");
  const pending = queue.items.filter((item: Data) => item.status === "pending");
  const reason = draft ? queueEditRefusal(queue, draft, error) : error;
  const edit = async (request: QueueEditInput, revision = queue.revision) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action("queueEdit", {
        projectId,
        threadId,
        ...request,
        expectedRevision: revision,
      });
      if (request.operation === "update") setDraft(null);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (!wasReported(failure))
        setError(
          failure.submissionUnknown
            ? t("recovery.operationUnconfirmed")
            : currentErrorText(failure),
        );
    } finally {
      setBusy(false);
    }
  };
  const run = (request: QueueEditInput, revision?: number) => void edit(request, revision);
  return (
    <div className="utility-content">
      <div className="utility-actions">
        <strong>{queue.paused ? "队列已暂停" : "消息队列"}</strong>
        <Button
          unstyled
          data-slot={undefined}
          type="submit"
          disabled={disabled || busy}
          onClick={() => run({ operation: queue.paused ? "resume" : "pause" })}
        >
          {queue.paused ? "继续队列" : "暂停队列"}
        </Button>
        <Button
          unstyled
          data-slot={undefined}
          type="submit"
          onClick={() =>
            void action("queue", { projectId, threadId }).catch((cause) =>
              setError((cause as Error).message),
            )
          }
        >
          刷新
        </Button>
      </div>
      <p className="text-foreground-subtle">
        暂停队列不会停止当前执行。排队消息保留加入时的模型与模式。
      </p>
      {queue.pauseReason && (
        <p>
          {queue.pauseReason === "serverDraining"
            ? t("chat.queue.pausedServerDraining")
            : queue.pauseReason === "user"
              ? t("chat.queue.pausedByUser")
              : queue.pauseReason}
        </p>
      )}
      {reason && (
        <FeedbackNotice transient tone="error" message={reason} onDismiss={() => setError("")} />
      )}
      {queue.items.length === 0 && <p>任务运行中可以继续发送消息，消息将在这里排队。</p>}
      {queue.items.map((item: Data) => {
        const position = pending.findIndex((entry: Data) => entry.id === item.id);
        const open = draft?.id === item.id ? draft : null;
        const current = queueText(item);
        const showControls = item.status === "pending" || !!open;
        return (
          <article key={item.id} data-core-queue-item={item.id}>
            <div className="utility-actions">
              <strong>{statusLabel[item.status] ?? item.status}</strong>
              <small>{item.configuration?.model?.modelId ?? "默认模型"}</small>
            </div>
            {open && current !== open.text && (
              <p>
                当前队列内容：<span>{current}</span>
              </p>
            )}
            {open ? (
              <Textarea
                unstyled
                data-slot={undefined}
                aria-label="编辑排队消息"
                value={open.text}
                onChange={(event) => setDraft({ ...open, text: event.target.value })}
              />
            ) : (
              <p className="whitespace-pre-wrap">{current}</p>
            )}
            {showControls && (
              <div className="utility-actions">
                <Button
                  unstyled
                  data-slot={undefined}
                  type="submit"
                  disabled={
                    disabled || busy || !item.input.every((part: Data) => part.type === "text")
                  }
                  title={
                    item.input.every((part: Data) => part.type === "text")
                      ? undefined
                      : "含附件消息请移除后重新添加"
                  }
                  onClick={() => {
                    if (open)
                      run(
                        { operation: "update", queueItemId: item.id, text: open.text },
                        open.revision,
                      );
                    else {
                      setError("");
                      setDraft({ id: item.id, text: current, revision: queue.revision });
                    }
                  }}
                >
                  {open ? "保存" : "编辑"}
                </Button>
                {open && queue.revision !== open.revision && item.status === "pending" && (
                  <Button
                    unstyled
                    data-slot={undefined}
                    type="submit"
                    disabled={disabled || busy}
                    onClick={() => setDraft({ ...open, revision: queue.revision })}
                  >
                    在最新版本上提交
                  </Button>
                )}
                {item.status === "pending" && (
                  <Button
                    unstyled
                    data-slot={undefined}
                    type="submit"
                    disabled={disabled || busy}
                    onClick={() => run({ operation: "remove", queueItemId: item.id })}
                  >
                    移除
                  </Button>
                )}
                {item.status === "pending" &&
                  [-1, 1].map((offset) => (
                    <Button
                      unstyled
                      data-slot={undefined}
                      type="submit"
                      key={offset}
                      disabled={
                        disabled ||
                        busy ||
                        position + offset < 0 ||
                        position + offset >= pending.length
                      }
                      onClick={() => {
                        const ids = pending.map((entry: Data) => entry.id);
                        [ids[position], ids[position + offset]] = [
                          ids[position + offset],
                          ids[position],
                        ];
                        run({ operation: "reorder", queueItemIds: ids });
                      }}
                    >
                      {offset < 0 ? "上移" : "下移"}
                    </Button>
                  ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
