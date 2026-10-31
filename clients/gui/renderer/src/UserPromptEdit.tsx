import { useI18n } from "./i18n/IntlProvider.js";
import "./UserPromptEdit.css";
import { stripGenUiModelContext } from "@areal/gen-ui/contract";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import { EditMessageIcon } from "./interfaceIcons.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { Button } from "./components/ui/button.js";
import { Spinner } from "./components/ui/spinner.js";
import { markSending, sending, subscribeSending } from "./Composer.js";
import type { Data, Action } from "./services.js";

export function UserPromptEdit({
  project,
  thread,
  item,
  action,
}: {
  project: Data;
  thread: Data;
  item: Data;
  action: Action;
}) {
  const { t } = useI18n();
  const key = `areal-gui:edit:${project.id}:${thread.id}:${item.id}`;
  const composerKey = `areal-gui:draft:${project.id}:${thread.id}`;
  const original = stripGenUiModelContext(
    (item.content ?? [])
      .filter((part: Data) => part.type === "text" && !part.mcpContent)
      .map((part: Data) => part.text)
      .join("\n"),
  );
  const [unknown, setUnknown] = useState<string | null>(() =>
    localStorage.getItem(`${key}:pending`),
  );
  const [open, setOpen] = useState(() => !!localStorage.getItem(`${key}:pending`));
  const [text, setText] = useState(() => localStorage.getItem(key) ?? original);
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState(() => ({
    expectedTurnId: thread.turns?.at(-1)?.id,
    expectedConfigRevision: project.configurations?.[thread.id]?.revision,
  }));
  const inFlight = useRef(false);
  const busy = useSyncExternalStore(subscribeSending, () => sending.has(composerKey));
  const pending = project.pending?.some((entry: Data) => entry.params?.threadId === thread.id);
  const queued = (project.state?.queues?.[thread.id] ?? thread.desktop?.queue)?.items?.some(
    (entry: Data) => ["pending", "running"].includes(entry.status),
  );
  const disabled =
    busy ||
    pending ||
    !!unknown ||
    !project.state?.connected ||
    thread.desktop?.archived ||
    queued ||
    thread.turns?.some((turn: Data) => turn.status === "inProgress");
  const close = () => {
    setOpen(false);
    setError("");
    setText(original);
    localStorage.removeItem(key);
  };
  useEffect(() => {
    if (!unknown || pending) return;
    const outcome = project.outcomes?.[unknown];
    if (!outcome) return;
    setUnknown(null);
    localStorage.removeItem(`${key}:pending`);
    if (outcome.accepted !== false) close();
    else setError(outcome.message || "发送未受理，修改内容已保留。");
  }, [unknown, pending, project.outcomes]);
  const submit = async (value: string) => {
    if (disabled || inFlight.current || !value.trim()) return;
    inFlight.current = true;
    markSending(composerKey, true);
    setError("");
    try {
      const content: Data[] = item.content ?? [];
      await action("editMessage", {
        projectId: project.id,
        threadId: thread.id,
        text: value,
        requestId: crypto.randomUUID(),
        ...anchor,
        itemId: item.id,
        attachments: content
          .filter((part) => part.type !== "text")
          .map((part) => ({
            type: part.type,
            url: part.url,
            ...(part.name ? { name: part.name } : {}),
            ...(part.mime_type || part.mimeType
              ? { mimeType: part.mime_type ?? part.mimeType }
              : {}),
          })),
        mcpContent: content
          .filter((part) => part.type === "text" && part.mcpContent)
          .map((part) => part.mcpContent),
      });
      close();
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      setError(failure.message);
      if (failure.submissionUnknown && failure.requestId) {
        localStorage.setItem(`${key}:pending`, failure.requestId);
        setUnknown(failure.requestId);
      }
    } finally {
      inFlight.current = false;
      markSending(composerKey, false);
    }
  };
  return (
    <>
      <ControlHintTooltip title="编辑消息">
        <Button
          unstyled
          data-slot={undefined}
          className="icon-button"
          type="button"
          aria-label="编辑消息"
          disabled={busy || pending || !project.state?.connected || thread.desktop?.archived}
          onClick={() => {
            setText(localStorage.getItem(key) ?? original);
            setAnchor({
              expectedTurnId: thread.turns?.at(-1)?.id,
              expectedConfigRevision: project.configurations?.[thread.id]?.revision,
            });
            setOpen(true);
          }}
        >
          <EditMessageIcon size={14} />
        </Button>
      </ControlHintTooltip>
      {open && (
        <section role="region" aria-label="编辑用户消息" className="user-prompt-edit w-full">
          <ChatPromptEditor
            workspacePath={project.root}
            taskId={thread.id}
            initialValue={text}
            inputTestId="user-prompt-edit-input"
            showMentionButton={false}
            showSlashButton={false}
            enableMentionPanel={false}
            enableWorkspaceFileDrop={false}
            enableExternalFileDrop={false}
            disabled={disabled}
            submitDisabled={disabled || !text.trim()}
            submitting={busy}
            submitLabel="发送"
            betweenCancelAndSubmitAction={
              <Button
                type="button"
                variant="outline"
                className="user-prompt-edit-cancel"
                disabled={!!unknown || busy}
                onClick={close}
              >
                取消
              </Button>
            }
            submitControl={
              <Button
                type="submit"
                variant="secondary"
                className="user-prompt-edit-send"
                aria-label="发送"
                disabled={disabled || !text.trim()}
              >
                {busy && <Spinner className="size-4" />}发送
              </Button>
            }
            onChange={(value) => {
              setText(value);
              localStorage.setItem(key, value);
            }}
            onSubmit={(value) => {
              void submit(value);
              return false;
            }}
            onCancel={unknown || busy ? undefined : close}
          />
          <p className="user-prompt-edit-note">{t("common.promptEdit.note")}</p>
          {error && <p role="alert">{error}</p>}
          {unknown && (
            <Button
              type="button"
              variant="ghost"
              disabled={!project.state?.connected || busy}
              onClick={() =>
                void action("reconcile", { projectId: project.id }).catch((cause) =>
                  setError(cause.message),
                )
              }
            >
              核对提交结果
            </Button>
          )}
        </section>
      )}
    </>
  );
}
