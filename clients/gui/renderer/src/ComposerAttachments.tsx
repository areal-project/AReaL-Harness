import { AttachmentCard } from "@areal/ui/wip";
import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useState } from "react";
import type { ChatComposerPasteEvent } from "./LexicalChatInput.js";
import { ScanText } from "lucide-react";
import { ImagePreview } from "./MessageAttachment.js";
import { imageAnnotation, useImageAnnotationRevision } from "./imageAnnotations.js";
import { CloseIcon, ReviewCommentGlyph } from "./interfaceIcons.js";

export type ComposerDraftAttachment = File | {
    readonly kind: "pasted-text";
    readonly text: string;
};

export function isComposerFile(attachment: ComposerDraftAttachment): attachment is File {
    return !("kind" in attachment && attachment.kind === "pasted-text");
}

export function composerInput(body: string, parts: readonly ComposerDraftAttachment[]): { text: string; files: File[] } {
    const text = body.length ? [body] : [];
    const files: File[] = [];
    for (const part of parts) {
        if (isComposerFile(part)) files.push(part);
        else if (part.text.length) text.push(part.text);
    }
    return { text: text.join("\n\n"), files };
}

export function composerPaste(event: ChatComposerPasteEvent, add: (files: ComposerDraftAttachment[]) => void) {
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
    !file.type || file.type === "application/octet-stream" || file.type.startsWith("text/") ||
    /\.(txt|md|json|ya?ml|csv|log|tsx?|jsx?|css|html|py|rs|toml)$/i.test(file.name);
export function ComposerAttachment({
    file,
    disabled,
    onRemove,
    onExpand,
    onAnnotate,
}: {
    file: ComposerDraftAttachment;
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
    const actualFile = isComposerFile(file) ? file : null;
    const name = isComposerFile(file) ? file.name : file.text.split(/\r?\n/).find(line => line.trim())?.trim() || "粘贴的文本";
    const image = actualFile?.type.startsWith("image/") === true;
    const count = actualFile ? imageAnnotation(actualFile)?.points.length ?? 0 : 0;
    useEffect(() => {
        if (!image || !actualFile) return;
        const value = URL.createObjectURL(actualFile);
        setUrl(value);
        return () => URL.revokeObjectURL(value);
    }, [actualFile, image]);
    const tile = (
        <AttachmentCard
            image={image}
            data-testid="composer-attachment"
        >
            {image ? (
                <>
                <AttachmentCard.Open type="button" aria-label={`预览图片 ${name}`} disabled={disabled} onClick={() => setPreviewOpen(true)}><img src={url} alt={name} /></AttachmentCard.Open>
                {previewOpen && <ImagePreview name={name} url={url} onClose={() => setPreviewOpen(false)} onAnnotate={onAnnotate && actualFile ? () => { setPreviewOpen(false); onAnnotate(actualFile); } : undefined} />}
                </>
            ) : (
                <>
                    <AttachmentCard.Icon>
                        <ScanText size={22} />
                    </AttachmentCard.Icon>
                    <AttachmentCard.Text>
                        <span title={name}>{name}</span>
                        {!actualFile || isText(actualFile) ? (
                            <button
                                type="button"
                                disabled={disabled || reading}
                                onClick={async () => {
                                    setReading(true);
                                    setError("");
                                    try {
                                        const size = isComposerFile(file) ? file.size : new TextEncoder().encode(file.text).byteLength;
                                        if (size > 1024 * 1024)
                                            throw new Error(
                                                "文本超过展开上限 1 MiB，请作为附件发送",
                                            );
                                        const text = isComposerFile(file) ? new TextDecoder("utf-8", {
                                            fatal: true,
                                        }).decode(await file.arrayBuffer()) : file.text;
                                        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(t("chat.composer.textFileBinaryControls"));
                                        onExpand(text);
                                    } catch (cause) {
                                        setError(
                                            `无法展开 ${name}：${(cause as Error).message}`,
                                        );
                                    } finally {
                                        setReading(false);
                                    }
                                }}
                            >
                                {reading ? "正在读取…" : "在文本框中显示"} ›
                            </button>
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
            {error && (
                <AttachmentCard.Error role="alert">
                    {error}
                </AttachmentCard.Error>
            )}
        </AttachmentCard>
    );
    return image ? <AttachmentCard.WithNote>{tile}{!!count && <AttachmentCard.Note type="button" disabled={disabled} aria-label={`${count} 条标注`} onClick={() => { if (actualFile) onAnnotate?.(actualFile); }}><ReviewCommentGlyph size={13} />{count} 条标注</AttachmentCard.Note>}</AttachmentCard.WithNote> : tile;
}
