import { TitleTooltip } from "@areal/ui";
import { SnapShotAttachment } from "./snapshots/SnapShotAttachment.js";
import { snapShotFile } from "./snapshots/source.js";
import { Button, Input } from "@areal/ui";
import { AttachmentCard } from "@areal/ui/experimental";
import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useRef, useState } from "react";
import type { ChatComposerPasteEvent } from "./LexicalChatInput.js";
import { ScanText } from "lucide-react";
import { ImagePreview } from "./MessageAttachment.js";
import { imageAnnotation, useImageAnnotationRevision } from "./imageAnnotations.js";
import { useComposerUploadState } from "./ComposerUploadState.js";
import { isTechnicalErrorMessage } from "./recoveryPresentation.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { CloseIcon, ReviewCommentGlyph } from "./interfaceIcons.js";

export type ComposerDraftAttachment =
  | File
  | {
      readonly kind: "missing-file";
      readonly name: string;
      readonly size: number;
      readonly type: string;
      readonly lastModified: number;
    }
  | {
      readonly kind: "pasted-text";
      readonly text: string;
    };

export function isComposerFile(attachment: ComposerDraftAttachment): attachment is File {
  return !("kind" in attachment);
}

export const hasMissingComposerFiles = (parts: readonly ComposerDraftAttachment[]) =>
  parts.some((part) => "kind" in part && part.kind === "missing-file");

export function composerInput(
  body: string,
  parts: readonly ComposerDraftAttachment[],
): { text: string; files: File[] } {
  const text = body.length ? [body] : [];
  const files: File[] = [];
  for (const part of parts) {
    if (isComposerFile(part)) files.push(part);
    else if (part.kind === "pasted-text" && part.text.length) text.push(part.text);
  }
  return { text: text.join("\n\n"), files };
}

export function composerPaste(
  event: ChatComposerPasteEvent,
  add: (files: ComposerDraftAttachment[]) => void,
) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length) {
    event.preventDefault();
    add(files);
    return;
  }
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text.length > 200 || text.split("\n").length >= 5) {
    event.preventDefault();
    add([{ kind: "pasted-text", text }]);
  }
}
const isText = (file: File) =>
  !file.type ||
  file.type === "application/octet-stream" ||
  file.type.startsWith("text/") ||
  /\.(txt|md|json|ya?ml|csv|log|tsx?|jsx?|css|html|py|rs|toml)$/i.test(file.name);
export function ComposerAttachment({
  file,
  disabled,
  onRemove,
  onExpand,
  onAnnotate,
  uploadOwner,
  onRetry,
  onReplace,
}: {
  file: ComposerDraftAttachment;
  uploadOwner?: string;
  onRetry?: (file: File) => Promise<unknown>;
  onReplace?: (file: File) => void;
  disabled?: boolean;
  onRemove: () => void;
  onExpand: (text: string) => void;
  onAnnotate?: (file: File) => void;
}) {
  const { t } = useI18n();
  useImageAnnotationRevision();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const replacementInput = useRef<HTMLInputElement>(null);
  const actualFile = isComposerFile(file) ? file : null;
  const preparation = useComposerUploadState(uploadOwner, actualFile);
  const missing = "kind" in file && file.kind === "missing-file";
  const name =
    isComposerFile(file) || missing
      ? file.name || t("chat.composer.unrestoredAttachment")
      : file.text
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.trim() || "粘贴的文本";
  const image = actualFile?.type.startsWith("image/") === true;
  const count = actualFile ? (imageAnnotation(actualFile)?.points.length ?? 0) : 0;
  useEffect(() => {
    if (!image || !actualFile) return;
    const value = URL.createObjectURL(actualFile);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [actualFile, image]);
  const snapshot = actualFile ? snapShotFile(actualFile) : undefined;
  const tile = snapshot ? (
    <SnapShotAttachment
      id={snapshot.id}
      source={snapshot.source}
      url={url}
      name={name}
      disabled={disabled}
      onRemove={onRemove}
    />
  ) : (
    <AttachmentCard
      image={image}
      data-testid="composer-attachment"
      data-attachment-state={missing ? "needs-reattach" : undefined}
    >
      {image ? (
        <>
          <AttachmentCard.Open
            type="button"
            aria-label={`预览图片 ${name}`}
            disabled={disabled}
            onClick={() => setPreviewOpen(true)}
          >
            <img src={url} alt={name} />
          </AttachmentCard.Open>
          {previewOpen && (
            <ImagePreview
              name={name}
              url={url}
              onClose={() => setPreviewOpen(false)}
              onAnnotate={
                onAnnotate && actualFile
                  ? () => {
                      setPreviewOpen(false);
                      onAnnotate(actualFile);
                    }
                  : undefined
              }
            />
          )}
        </>
      ) : (
        <>
          <AttachmentCard.Icon>
            <ScanText size={22} />
          </AttachmentCard.Icon>
          <AttachmentCard.Text>
            <TitleTooltip title={name}>
              <span>{name}</span>
            </TitleTooltip>
            {missing ? (
              <>
                <small role="status">{t("chat.composer.attachmentNeedsReattach")}</small>
                <Button
                  unstyled
                  data-slot={undefined}
                  type="button"
                  disabled={disabled}
                  onClick={() => replacementInput.current?.click()}
                >
                  {t("chat.composer.reattachFile")}
                </Button>
                <Input
                  unstyled
                  data-slot={undefined}
                  ref={replacementInput}
                  type="file"
                  hidden
                  aria-label={t("chat.composer.reattachFile")}
                  disabled={disabled}
                  onChange={(event) => {
                    const replacement = event.currentTarget.files?.[0];
                    if (replacement) onReplace?.(replacement);
                  }}
                />
              </>
            ) : !actualFile || isText(actualFile) ? (
              <Button
                unstyled
                data-slot={undefined}
                type="button"
                disabled={disabled || reading}
                onClick={async () => {
                  setReading(true);
                  setError("");
                  try {
                    if ("kind" in file && file.kind === "missing-file") return;
                    const size = isComposerFile(file)
                      ? file.size
                      : new TextEncoder().encode(file.text).byteLength;
                    if (size > 1024 * 1024)
                      throw new Error("文本超过展开上限 1 MiB，请作为附件发送");
                    const text = isComposerFile(file)
                      ? new TextDecoder("utf-8", {
                          fatal: true,
                        }).decode(await file.arrayBuffer())
                      : file.text;
                    if (
                      [...text].some(
                        (character) =>
                          character.charCodeAt(0) < 32 && !"\t\n\r".includes(character),
                      )
                    )
                      throw new Error(t("chat.composer.textFileBinaryControls"));
                    onExpand(text);
                  } catch (cause) {
                    setError(`无法展开 ${name}：${(cause as Error).message}`);
                  } finally {
                    setReading(false);
                  }
                }}
              >
                {reading ? "正在读取…" : "在文本框中显示"} ›
              </Button>
            ) : (
              <small>{Math.ceil(actualFile.size / 1024)} KB</small>
            )}
          </AttachmentCard.Text>
        </>
      )}
      <AttachmentCard.Remove
        type="button"
        disabled={disabled || reading}
        aria-label={`移除附件 ${name}`}
        onClick={onRemove}
      >
        <CloseIcon size={12} />
      </AttachmentCard.Remove>
    </AttachmentCard>
  );
  const attachment =
    image && !snapshot ? (
      <AttachmentCard.WithNote>
        {tile}
        {!!count && (
          <AttachmentCard.Note
            type="button"
            disabled={disabled}
            aria-label={`${count} 条标注`}
            onClick={() => {
              if (actualFile) onAnnotate?.(actualFile);
            }}
          >
            <ReviewCommentGlyph size={13} />
            {count} 条标注
          </AttachmentCard.Note>
        )}
      </AttachmentCard.WithNote>
    ) : (
      tile
    );
  return (
    <div
      className={
        snapshot
          ? "flex w-52 max-w-full flex-none flex-col gap-1 break-words"
          : "composer-attachment-item"
      }
      data-upload-state={actualFile ? (preparation?.state ?? "pending") : undefined}
    >
      {attachment}
      {error && (
        <FeedbackNotice
          tone="error"
          message={
            isTechnicalErrorMessage(error) ? `${name}: ${t("recovery.operationFailed")}` : error
          }
          detail={isTechnicalErrorMessage(error) ? error : undefined}
          onDismiss={() => setError("")}
        />
      )}
      {actualFile && preparation?.state === "failed" && onRetry && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            void onRetry(actualFile).catch(() => {});
          }}
        >
          {t("chat.composer.retryAttachment")}
        </Button>
      )}
    </div>
  );
}
