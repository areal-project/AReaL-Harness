import type { Attachment } from "./services.js";
import { composerDraftStorage, flushComposerDrafts } from "./composerDraftStorage.js";
import { currentErrorText } from "./errors/currentErrorText.js";
import { errorCode, errorText } from "./errors/errorCopy.js";
import { DraftAttachment } from "./MessageAttachment.js";
import { AttachmentIcon } from "./interfaceIcons.js";
import { forgetComposerUploads } from "./ComposerUploadState.js";
import { uploadComposerFiles } from "./ComposerUploads.js";
import { PendingMessageView } from "./UserMessageBody.js";
import {
  acceptPendingMessage,
  setPendingMessage,
  usePendingMessage,
  userMessageIds,
} from "./pendingMessage.js";

import { useEffect, useRef, useState } from "react";
import type { Action, Data } from "./services.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { useI18n, formatUiMessage, type UiMessage } from "./i18n/IntlProvider.js";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { isTechnicalErrorMessage } from "./recoveryPresentation.js";

const fileDrafts = new Map<string, File[]>();
const uploadReceipts = new Map<string, Map<File, Attachment>>();
const draftErrors = new Map<string, string | UiMessage>();

export function CloudComposer({
  project,
  thread,
  dark = false,
  action,
  onOpen,
  cloudConfigured,
  cloudStatusChecking = false,
  cloudStatusError,
  onOpenCloudSettings,
}: {
  project: Data;
  thread?: Data;
  dark?: boolean;
  action: Action;
  onOpen?: (projectId: string, threadId: string) => Promise<void>;
  /** 新建草稿态下由宿主传入 Cloud 配置状态；已有云端会话忽略此字段。 */
  cloudConfigured?: boolean;
  cloudStatusChecking?: boolean;
  cloudStatusError?: string;
  onOpenCloudSettings?: () => void;
}) {
  const { t } = useI18n();
  const input = useRef<LexicalChatInputHandle | null>(null);
  const prefs = useApplicationPreferences();
  // 新建草稿与本地 DraftComposer 共用纯文本键，切换「本地 ↔ 云端」时不丢已输入文本。
  const draftKey = thread
    ? `areal-cloud-draft:${project.id}:${thread.id}`
    : `areal-gui:draft:${project.id}:new`;
  const pendingKey = `areal-gui:draft:${project.id}:${thread ? thread.id : "new"}`;
  const createRequestKey = `areal-cloud-draft:${project.id}:${thread?.id ?? "new"}:create`;
  const unknownKey = `areal-cloud-draft:${project.id}:${thread?.id ?? "new"}:unknown`;
  const fileKey = `areal-cloud-draft:${project.id}:${thread?.id ?? "new"}`;
  const [text, setText] = useState(() => composerDraftStorage.getItem(draftKey) ?? "");
  const upload = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>(() => fileDrafts.get(fileKey) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<string | UiMessage>(() => draftErrors.get(fileKey) ?? "");
  const [unknown, setUnknown] = useState(() => localStorage.getItem(unknownKey) === "true");
  const unconfigured = !thread && cloudConfigured === false && !cloudStatusChecking;
  const outgoing = usePendingMessage(pendingKey);

  useEffect(() => flushComposerDrafts, [draftKey]);
  useEffect(() => {
    const refreshDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== draftKey) return;
      const next = composerDraftStorage.getItem(draftKey) ?? "";
      setText(next);
      input.current?.setText(next);
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [draftKey]);

  const setError = (message: string | UiMessage) => {
    if (message) draftErrors.set(fileKey, message);
    else draftErrors.delete(fileKey);
    setErrorState(message);
  };
  const updateFiles = (next: File[]) => {
    fileDrafts.set(fileKey, next);
    setFiles(next);
  };
  const running = thread?.turns?.find((turn: Data) => turn.status === "inProgress");
  const addFiles = (incoming: File[]) => {
    if (busy || running || unknown || unconfigured) return;
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
      setError(errorText(t, cause));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (
      busy ||
      running ||
      unknown ||
      unconfigured ||
      (!thread && cloudStatusChecking) ||
      (!text.trim() && !files.length)
    )
      return;
    const submittedText = text;
    const submittedFiles = [...files];
    const startedAt = Date.now();
    const previousUserIds = thread ? userMessageIds(thread.turns) : [];
    setBusy(true);
    setError("");
    // 发出瞬间先在消息区展示用户气泡与内联状态，并就地清空输入框；持久化草稿保留到真正发送成功后才删。
    setPendingMessage(pendingKey, {
      text: submittedText,
      files: submittedFiles,
      previousUserIds,
      starting: !thread,
      status: !thread ? "cloud.startingSandbox" : "chat.submission.sending",
      startedAt: !thread ? startedAt : undefined,
    });
    setText("");
    input.current?.setText("");
    setFiles([]);
    let target = thread?.id;
    let sandboxElapsedSeconds: number | undefined;
    let opening: Promise<unknown> | undefined;
    try {
      if (!target) {
        const requestId = localStorage.getItem(createRequestKey) ?? crypto.randomUUID();
        localStorage.setItem(createRequestKey, requestId);
        const created = await action("cloudSession", {
          operation: "create",
          projectId: project.id,
          requestId,
        });
        target = created.threadId;
        sandboxElapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        composerDraftStorage.setItem(`areal-cloud-draft:${project.id}:${target}`, submittedText);
        setPendingMessage(pendingKey, {
          text: submittedText,
          files: submittedFiles,
          previousUserIds: [],
          starting: false,
          status: "cloud.sandboxReadySending",
          elapsedSeconds: sandboxElapsedSeconds,
        });
        // 先在原组件提交首轮，再切换；避免两个 Composer 同时拥有同一草稿。
      }
      const receiptKey = `${project.id}:${target}`;
      const accepted = uploadReceipts.get(receiptKey) ?? new Map<File, Attachment>();
      uploadReceipts.set(receiptKey, accepted);
      const attachments = await uploadComposerFiles(
        action,
        project.id,
        target,
        submittedFiles,
        accepted,
      );
      await action("cloudSession", {
        operation: "send",
        projectId: project.id,
        threadId: target,
        text: submittedText,
        attachments,
      });
      forgetComposerUploads(JSON.stringify([project.id, target]), submittedFiles);
      uploadReceipts.delete(receiptKey);
      fileDrafts.delete(fileKey);
      composerDraftStorage.removeItem(draftKey);
      localStorage.removeItem(createRequestKey);
      composerDraftStorage.removeItem(`areal-cloud-draft:${project.id}:${target}`);
      if (!thread) {
        setPendingMessage(`areal-gui:draft:${project.id}:${target}`, {
          text: submittedText,
          files: submittedFiles,
          previousUserIds: [],
          starting: false,
          status: "cloud.sandboxReadySending",
          elapsedSeconds: sandboxElapsedSeconds,
          accepted: true,
        });
        opening = Promise.resolve(onOpen?.(project.id, target));
        await opening;
      } else {
        acceptPendingMessage(pendingKey);
      }
    } catch (cause) {
      setPendingMessage(pendingKey);
      const failure = cause as Error & { submissionUnknown?: boolean };
      setError(errorText(t, failure));
      if (errorCode(failure) === "SUBMISSION_UNKNOWN") {
        setUnknown(true);
        localStorage.setItem(unknownKey, "true");
        if (target)
          localStorage.setItem(`areal-cloud-draft:${project.id}:${target}:unknown`, "true");
      }
      if (target && !thread) {
        const targetKey = `areal-cloud-draft:${project.id}:${target}`;
        composerDraftStorage.setItem(targetKey, submittedText);
        fileDrafts.set(targetKey, submittedFiles);
        draftErrors.set(targetKey, currentErrorText(failure));
        // 创建已完成，失败草稿归属该会话；后续新聊天必须生成独立的创建标识。
        composerDraftStorage.removeItem(draftKey);
        localStorage.removeItem(createRequestKey);
        localStorage.removeItem(unknownKey);
        fileDrafts.delete(fileKey);
        draftErrors.delete(fileKey);
        await onOpen?.(project.id, target);
      } else {
        setText(submittedText);
        input.current?.setText(submittedText);
        setFiles(submittedFiles);
      }
    } finally {
      if (!thread) {
        if (opening) void opening.finally(() => setPendingMessage(pendingKey));
        else setPendingMessage(pendingKey);
      }
      setBusy(false);
    }
  };
  const disconnected = Boolean(thread && !thread.cloud?.connected);
  const failureMessage = formatUiMessage(t, error || thread?.cloud?.error || "");
  const reconnectAction = disconnected ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={() => void reconnect()}
    >
      {t("cloud.reconnect")}
    </Button>
  ) : undefined;
  return (
    <div className="composer-dock cloud-composer" data-v4-composer-dock="true">
      {!thread && outgoing && (
        <div className="draft-message-preview">
          <PendingMessageView message={outgoing} theme={dark ? "dark" : "light"} />
        </div>
      )}
      <div className="composer-input-stack flex flex-col gap-2">
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
          placeholder={!thread ? t("cloud.draftHint") : t("cloud.prompt")}
          disabled={busy || !!running || unknown}
          submitDisabled={
            busy ||
            !!running ||
            unknown ||
            unconfigured ||
            (!thread && cloudStatusChecking) ||
            (!text.trim() && !files.length)
          }
          submitting={busy}
          enterSubmits={prefs.sendShortcut === "enter"}
          enableMentionPanel={false}
          hasDraftContent={files.length > 0}
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
                group: "features",
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
            composerDraftStorage.scheduleItem(draftKey, value);
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
                  }).catch((cause) => setError(errorText(t, cause)));
                }}
              >
                {t("cloud.stop")}
              </Button>
            ) : undefined
          }
        />
        {unconfigured && (
          <FeedbackNotice
            tone="info"
            message={cloudStatusError || t("cloud.unconfiguredNotice")}
            actions={
              onOpenCloudSettings && (
                <Button type="button" variant="ghost" size="sm" onClick={onOpenCloudSettings}>
                  {t("cloud.openSettings")}
                </Button>
              )
            }
          />
        )}
        {disconnected && !busy && !unknown && !failureMessage && (
          <FeedbackNotice
            tone="warning"
            message={t("cloud.disconnected")}
            actions={reconnectAction}
          />
        )}
        {unknown && (
          <FeedbackNotice
            tone="warning"
            message={t("cloud.submissionUnknown")}
            detail={failureMessage || undefined}
            actions={
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setUnknown(false);
                    localStorage.removeItem(unknownKey);
                  }}
                >
                  {t("cloud.acknowledgeUnknown")}
                </Button>
                {reconnectAction}
              </>
            }
          />
        )}
        {!unknown && failureMessage && (
          <FeedbackNotice
            tone="error"
            message={
              isTechnicalErrorMessage(failureMessage)
                ? t("recovery.operationFailed")
                : failureMessage
            }
            detail={isTechnicalErrorMessage(failureMessage) ? failureMessage : undefined}
            actions={reconnectAction}
          />
        )}
      </div>
    </div>
  );
}
