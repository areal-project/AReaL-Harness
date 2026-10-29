import type { Attachment } from "@areal/workbench/desktop-contract/conversation";
import { DraftAttachment } from "./MessageAttachment.js";
import { AttachmentIcon } from "./interfaceIcons.js";
import { uploadComposerFiles } from "./ComposerUploads.js";

import { useRef, useState } from "react";
import type { Action, Data } from "./services.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { useI18n, formatUiMessage, type UiMessage } from "./i18n/IntlProvider.js";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";

const fileDrafts = new Map<string, File[]>();
const uploadReceipts = new Map<string, Map<File, Attachment>>();
const draftErrors = new Map<string, string | UiMessage>();

export function CloudComposer({
  project,
  thread,
  action,
  onOpen,
}: {
  project: Data;
  thread?: Data;
  action: Action;
  onOpen?: (projectId: string, threadId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const input = useRef<LexicalChatInputHandle | null>(null);
  const prefs = useApplicationPreferences();
  const key = `areal-cloud-draft:${project.id}:${thread?.id ?? "new"}`;
  const [text, setText] = useState(() => localStorage.getItem(key) ?? "");
  const upload = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>(() => fileDrafts.get(key) ?? []);
  const updateFiles = (next: File[]) => {
    fileDrafts.set(key, next);
    setFiles(next);
  };
  const addFiles = (incoming: File[]) => {
    if (busy || running || unknown) return;
    if (files.length + incoming.length > 16) {
      setError({ id: "cloud.attachmentsLimit" });
      return;
    }
    if (incoming.some((file) => !file.size || file.size > 16 * 1024 * 1024)) {
      setError({ id: "cloud.attachmentSize" });
      return;
    }
    updateFiles([...files, ...incoming]);
    setError("");
  };
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<string | UiMessage>(() => draftErrors.get(key) ?? "");
  const setError = (message: string | UiMessage) => {
    if (message) draftErrors.set(key, message);
    else draftErrors.delete(key);
    setErrorState(message);
  };
  const [unknown, setUnknown] = useState(() => localStorage.getItem(`${key}:unknown`) === "true");
  const running = thread?.turns?.find((turn: Data) => turn.status === "inProgress");
  const reconnect = async () => {
    if (busy || !thread) return;
    setBusy(true);
    setError("");
    try {
      await action("cloudSession", {
        operation: "reconnect",
        projectId: project.id,
        threadId: thread.id,
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (busy || running || unknown || (!text.trim() && !files.length)) return;
    setBusy(true);
    setError("");
    let target = thread?.id;
    try {
      if (!target) {
        const requestId = localStorage.getItem(`${key}:create`) ?? crypto.randomUUID();
        localStorage.setItem(`${key}:create`, requestId);
        const created = await action("cloudSession", {
          operation: "create",
          projectId: project.id,
          requestId,
        });
        target = created.threadId;
        localStorage.setItem(`areal-cloud-draft:${project.id}:${target}`, text);
        // 先在原组件提交首轮，再切换；避免两个 Composer 同时拥有同一草稿。
      }
      const receiptKey = `${project.id}:${target}`;
      const accepted = uploadReceipts.get(receiptKey) ?? new Map<File, Attachment>();
      uploadReceipts.set(receiptKey, accepted);
      const attachments = await uploadComposerFiles(action, project.id, target, files, accepted);
      await action("cloudSession", {
        operation: "send",
        projectId: project.id,
        threadId: target,
        text,
        attachments,
      });
      uploadReceipts.delete(receiptKey);
      fileDrafts.delete(key);
      setFiles([]);
      localStorage.removeItem(key);
      localStorage.removeItem(`${key}:create`);
      localStorage.removeItem(`areal-cloud-draft:${project.id}:${target}`);
      setText("");
      input.current?.setText("");
      if (!thread) await onOpen?.(project.id, target);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      setError(failure.message);
      if (failure.submissionUnknown) {
        setUnknown(true);
        localStorage.setItem(`${key}:unknown`, "true");
        if (target)
          localStorage.setItem(`areal-cloud-draft:${project.id}:${target}:unknown`, "true");
      }
      if (target && !thread) {
        const targetKey = `areal-cloud-draft:${project.id}:${target}`;
        localStorage.setItem(targetKey, text);
        fileDrafts.set(targetKey, files);
        draftErrors.set(targetKey, failure.message);
        // 创建已完成，失败草稿归属该会话；后续新聊天必须生成独立的创建标识。
        localStorage.removeItem(key);
        localStorage.removeItem(`${key}:create`);
        localStorage.removeItem(`${key}:unknown`);
        fileDrafts.delete(key);
        draftErrors.delete(key);
        await onOpen?.(project.id, target);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="composer-dock cloud-composer flex flex-col gap-2">
      <span
        role="status"
        className="cloud-connection-status inline-flex items-center gap-2 text-ui-sm text-foreground-subtle"
        data-state={thread?.cloud?.connected ? "connected" : "idle"}
      >
        <span
          className={`size-2 rounded-full ${thread?.cloud?.connected ? "bg-[var(--color-success)]" : "bg-foreground-subtle"}`}
          aria-hidden="true"
        />
        {t(
          thread?.cloud?.connected
            ? "cloud.connected"
            : busy
              ? "cloud.connecting"
              : "cloud.disconnected",
        )}
      </span>
      <Input
        ref={upload}
        type="file"
        multiple
        hidden
        aria-label={t("cloud.attachments")}
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <ChatPromptEditor
        workspacePath=""
        taskId={thread?.id ?? null}
        initialValue={text}
        inputApiRef={input}
        inputTestId="cloud-chat-input"
        submitTestId="cloud-chat-send"
        placeholder={t("cloud.prompt")}
        disabled={busy || !!running || unknown}
        submitDisabled={busy || !!running || unknown || (!text.trim() && !files.length)}
        submitting={busy}
        enterSubmits={prefs.sendShortcut === "enter"}
        enableMentionPanel={false}
        allowSubmitWhenEmpty={files.length > 0}
        enableExternalFileDrop
        onPaste={(event) => {
          const pasted = Array.from(event.clipboardData?.files ?? []);
          if (pasted.length) {
            event.preventDefault();
            addFiles(pasted);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          addFiles(Array.from(event.dataTransfer.files));
        }}
        composerCatalog={{
          refresh: () => {},
          entries: [
            {
              value: "upload",
              label: t("cloud.upload"),
              description: t("cloud.uploadDescription"),
              group: "功能",
              icon: <AttachmentIcon />,
              run: () => upload.current?.click(),
            },
          ],
        }}
        topContent={
          files.length ? (
            <div className="composer-attachments" data-testid="cloud-attachments">
              {files.map((file, index) => (
                <DraftAttachment
                  key={`${file.name}-${index}`}
                  file={file}
                  onRemove={() => {
                    if (!busy && !running && !unknown)
                      updateFiles(files.filter((_, i) => i !== index));
                  }}
                />
              ))}
            </div>
          ) : undefined
        }
        submitLabel={t("cloud.send")}
        onChange={(value) => {
          setText(value);
          localStorage.setItem(key, value);
        }}
        onSubmit={() => {
          void send();
          return false;
        }}
        submitControl={
          running ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                void action("cloudSession", {
                  operation: "stop",
                  projectId: project.id,
                  threadId: thread?.id,
                  turnId: running.id,
                }).catch((cause) => setError(cause.message));
              }}
            >
              {t("cloud.stop")}
            </Button>
          ) : undefined
        }
      />
      {unknown && (
        <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">
          {t("cloud.submissionUnknown")}
          <Button
            type="button"
            onClick={() => {
              setUnknown(false);
              localStorage.removeItem(`${key}:unknown`);
            }}
          >
            {t("cloud.acknowledgeUnknown")}
          </Button>
        </p>
      )}
      {thread && !thread.cloud?.connected && (
        <Button type="button" disabled={busy} onClick={() => void reconnect()}>
          {t("cloud.reconnect")}
        </Button>
      )}
      {(error || thread?.cloud?.error) && (
        <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">
          {formatUiMessage(t, error || thread?.cloud?.error)}
        </p>
      )}
    </div>
  );
}
