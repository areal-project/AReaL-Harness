import { useRef, useState, useEffect } from "react";
import type { RefObject } from "react";
import type { Action, Data } from "./services.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";

type QueueEdit = {
  id: string;
  revision: number;
  wasPaused: boolean;
  phase: "opening" | "editing" | "saving" | "restoring";
  attachments: Data[];
  original: { text: string; skills: string | null; goal: string | null };
  unknown?: { requestId: string; operation: "pause" | "update" | "resume" };
};

/** 只保存主 Composer 的未提交输入；队列内容、版本和受理结果始终由 Core 确认。 */
export function useComposerQueueEdit({
  project,
  threadId,
  draftKey,
  action,
  readAction,
  api,
  draftFiles,
  setText,
  setFiles,
  setGoalMode,
  uploadFiles,
  inFlight,
  setInFlight,
}: {
  project: Data;
  threadId: string;
  draftKey: string;
  action: Action;
  readAction: Action;
  api: RefObject<LexicalChatInputHandle | null>;
  draftFiles: Map<string, File[]>;
  setText: (text: string) => void;
  setFiles: (files: File[]) => void;
  setGoalMode: (enabled: boolean) => void;
  uploadFiles: (files: File[]) => Promise<Data[]>;
  inFlight: boolean;
  setInFlight: (active: boolean) => void;
}) {
  const storageKey = `${draftKey}:queue-edit`;
  const backupKey = `${storageKey}:original`;
  const [edit, setEdit] = useState<QueueEdit | null>(() =>
    JSON.parse(localStorage.getItem(storageKey) ?? "null"),
  );
  const [localBusy, setLocalBusy] = useState(false);
  const busy = localBusy || inFlight;
  const setBusy = (active: boolean) => {
    setInFlight(active);
    if (owner.current) setLocalBusy(active);
  };
  const [error, setError] = useState("");
  const owner = useRef(true);
  useEffect(() => {
    owner.current = true;
    return () => {
      owner.current = false;
    };
  }, []);
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === draftKey)
        setEdit(JSON.parse(localStorage.getItem(storageKey) ?? "null"));
    };
    window.addEventListener("areal-draft-change", refresh);
    return () => window.removeEventListener("areal-draft-change", refresh);
  }, [draftKey, storageKey]);
  const queue = project.state?.queues?.[threadId];
  const pending = project.pending?.some((entry: Data) => entry.params?.threadId === threadId);
  const connected = project.state?.connected === true;
  const item = queue?.items?.find((entry: Data) => entry.id === edit?.id);
  const conflict =
    !!edit &&
    edit.phase === "editing" &&
    (!item || item.status !== "pending" || queue?.revision !== edit.revision || !queue?.paused);
  const feedback = edit?.unknown
    ? "队列操作结果尚未确认，编辑内容已保留，不会自动重发。"
    : conflict
      ? "队列或消息已有更新，编辑内容已保留。请取消编辑后核对当前队列；不会覆盖新版本或自动继续。"
      : error;
  const saveRecord = (value: QueueEdit | null) => {
    if (value) localStorage.setItem(storageKey, JSON.stringify(value));
    else localStorage.removeItem(storageKey);
    if (owner.current) setEdit(value);
    window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: draftKey }));
  };
  const sync = () => {
    window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: draftKey }));
    if (owner.current) {
      const text = localStorage.getItem(draftKey) ?? "";
      api.current?.setText(text);
      setText(text);
      setFiles(draftFiles.get(draftKey) ?? []);
      setGoalMode(localStorage.getItem(`${draftKey}:goal`) === "true");
      api.current?.focus();
    }
  };
  const restoreLocal = (record: QueueEdit, message = "") => {
    localStorage.setItem(draftKey, record.original.text);
    for (const [suffix, value] of [
      ["skills", record.original.skills],
      ["goal", record.original.goal],
    ] as const) {
      if (value !== null) localStorage.setItem(`${draftKey}:${suffix}`, value);
      else localStorage.removeItem(`${draftKey}:${suffix}`);
    }
    draftFiles.set(draftKey, draftFiles.get(backupKey) ?? []);
    draftFiles.delete(backupKey);
    saveRecord(null);
    sync();
    if (owner.current) setError(message);
  };
  const enter = (record: QueueEdit, confirmed: Data, input: Data[]) => {
    if (!confirmed.paused) throw new Error("队列未确认暂停，原草稿已保留");
    saveRecord({ ...record, revision: confirmed.revision, phase: "editing", unknown: undefined });
    localStorage.setItem(
      draftKey,
      input
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
    localStorage.removeItem(`${draftKey}:skills`);
    localStorage.removeItem(`${draftKey}:goal`);
    draftFiles.set(draftKey, []);
    sync();
  };
  const mutation = (
    record: QueueEdit,
    operation: "pause" | "update" | "resume",
    values: Data = {},
  ) => {
    const requestId = crypto.randomUUID();
    // 请求发出前保留业务键；切换任务或重新挂载后只读核对原请求。
    saveRecord({ ...record, unknown: { requestId, operation } });
    return action("queueEdit", {
      projectId: project.id,
      threadId,
      expectedRevision: record.revision,
      requestId,
      operation,
      ...values,
    });
  };
  const unknown = (
    record: QueueEdit,
    cause: Error & { submissionUnknown?: boolean; requestId?: string },
    operation: "pause" | "update" | "resume",
  ) => {
    saveRecord({
      ...record,
      ...(cause.submissionUnknown && cause.requestId
        ? { unknown: { requestId: cause.requestId, operation } }
        : {}),
    });
    if (owner.current) setError(cause.message);
  };
  const begin = async (target: Data) => {
    if (edit || busy || pending || !connected || target.status !== "pending") return;
    const record: QueueEdit = {
      id: target.id,
      revision: queue.revision,
      wasPaused: queue.paused,
      phase: "opening",
      attachments: target.input.filter((part: Data) => part.type !== "text"),
      original: {
        text: api.current?.getMarkdown() ?? localStorage.getItem(draftKey) ?? "",
        skills: localStorage.getItem(`${draftKey}:skills`),
        goal: localStorage.getItem(`${draftKey}:goal`),
      },
    };
    saveRecord(record);
    draftFiles.set(backupKey, draftFiles.get(draftKey) ?? []);
    setBusy(true);
    setError("");
    try {
      const paused = queue.paused
        ? await readAction("queue", { projectId: project.id, threadId })
        : await mutation(record, "pause");
      if (
        paused.revision !== record.revision + (record.wasPaused ? 0 : 1) ||
        paused.items.find((row: Data) => row.id === target.id)?.status !== "pending"
      )
        throw new Error("暂停时队列已有更新，原草稿已保留，请取消后重新核对");
      enter(record, paused, target.input);
    } catch (cause) {
      unknown(record, cause as Error, "pause");
    } finally {
      setBusy(false);
    }
  };
  const finish = async (record: QueueEdit) => {
    saveRecord({ ...record, phase: "restoring", unknown: undefined });
    if (record.wasPaused || record.phase === "opening") {
      restoreLocal(record);
      return;
    }
    try {
      const latest = await readAction("queue", { projectId: project.id, threadId });
      // 暂停与版本必须仍属于本次编辑；外部变更后只恢复本地输入，不恢复旧队列状态。
      if (latest.revision !== record.revision || !latest.paused || latest.pauseReason !== "user") {
        restoreLocal(record, "原草稿已恢复；队列状态已有更新，保持当前状态。");
        return;
      }
      await mutation({ ...record, phase: "restoring" }, "resume");
      restoreLocal(record);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      if (failure.submissionUnknown) unknown({ ...record, phase: "restoring" }, failure, "resume");
      else restoreLocal(record, `原草稿已恢复；队列未自动继续：${failure.message}`);
    }
  };
  const save = async () => {
    if (
      !edit ||
      edit.phase !== "editing" ||
      edit.unknown ||
      conflict ||
      busy ||
      pending ||
      !connected
    )
      return;
    setBusy(true);
    setError("");
    const record = { ...edit, phase: "saving" as const };
    saveRecord(record);
    try {
      const additions = await uploadFiles(draftFiles.get(draftKey) ?? []);
      const updated = await mutation(record, "update", {
        queueItemId: record.id,
        text: localStorage.getItem(draftKey) ?? "",
        attachments: additions,
        retainedInput: record.attachments,
      });
      await finish({ ...record, revision: updated.revision });
    } catch (cause) {
      unknown({ ...record, phase: "editing" }, cause as Error, "update");
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!edit || edit.unknown || busy || pending) return;
    setBusy(true);
    try {
      await finish(edit);
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async () => {
    if (!edit?.unknown || busy || !connected) return;
    setBusy(true);
    try {
      const result = await action("reconcile", { projectId: project.id });
      const known = result.outcomes?.[edit.unknown.requestId];
      const observed =
        known ??
        (await readAction("queue", {
          projectId: project.id,
          threadId,
          requestId: edit.unknown.requestId,
          operation: edit.unknown.operation,
        }));
      const outcome = known || observed.confirmed ? observed : null;
      if (!outcome) {
        setError("Core 尚未确认原请求，请继续保留编辑内容并核对状态。");
        return;
      }
      const record = { ...edit, unknown: undefined };
      if (!outcome.accepted) {
        if (edit.unknown.operation === "resume") restoreLocal(record, outcome.message);
        else {
          saveRecord(record);
          setError(outcome.message ?? "原请求被拒绝，输入已保留。");
        }
      } else if (edit.unknown.operation === "pause") {
        const latest = await readAction("queue", { projectId: project.id, threadId });
        if (
          latest.revision !== outcome.result.revision ||
          latest.items.find((row: Data) => row.id === record.id)?.status !== "pending"
        ) {
          saveRecord(record);
          setError("暂停已确认，但队列随后更新；原草稿已保留，请取消后核对。");
        } else enter(record, latest, latest.items.find((row: Data) => row.id === record.id).input);
      } else if (edit.unknown.operation === "update")
        await finish({ ...record, revision: outcome.result.revision });
      else restoreLocal(record);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return {
    edit,
    busy,
    conflict,
    feedback,
    begin,
    save,
    cancel,
    reconcile,
    locked: !!edit && (edit.phase !== "editing" || !!edit.unknown),
    saveDisabled:
      busy || pending || !connected || conflict || edit?.phase !== "editing" || !!edit?.unknown,
    removeAttachment: (index: number) => {
      if (edit && !busy && !edit.unknown)
        saveRecord({ ...edit, attachments: edit.attachments.filter((_, at) => at !== index) });
    },
  };
}
