import { useEffect, useState } from "react";
import type { ChatComposerPasteEvent } from "./LexicalChatInput.js";
import { ScanText } from "lucide-react";
import { CloseIcon } from "./interfaceIcons.js";

export function composerPaste(event: ChatComposerPasteEvent, add: (files: File[]) => void) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) {
        event.preventDefault();
        add(files);
        return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length > 200 || text.split("\n").length >= 5) {
        event.preventDefault();
        add([new File([text], "粘贴的文本.txt", { type: "text/plain" })]);
    }
}
const isText = (file: File) =>
    file.type.startsWith("text/") ||
    /\.(txt|md|json|ya?ml|csv|log|tsx?|jsx?|css|html|py|rs|toml)$/i.test(file.name);
export function ComposerAttachment({
    file,
    disabled,
    onRemove,
    onExpand,
}: {
    file: File;
    disabled?: boolean;
    onRemove: () => void;
    onExpand: (text: string) => void;
}) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    const [reading, setReading] = useState(false);
    const image = file.type.startsWith("image/");
    useEffect(() => {
        if (!image) return;
        const value = URL.createObjectURL(file);
        setUrl(value);
        return () => URL.revokeObjectURL(value);
    }, [file, image]);
    return (
        <div
            className={image ? "composer-image-card" : "composer-text-card"}
            data-testid="composer-attachment"
        >
            {image ? (
                <img src={url} alt={file.name} />
            ) : (
                <>
                    <span className="composer-text-icon">
                        <ScanText size={22} />
                    </span>
                    <div className="composer-text-copy">
                        <span title={file.name}>{file.name}</span>
                        {isText(file) ? (
                            <button
                                type="button"
                                disabled={disabled || reading}
                                onClick={async () => {
                                    setReading(true);
                                    setError("");
                                    try {
                                        if (file.size > 1024 * 1024)
                                            throw new Error(
                                                "文本超过展开上限 1 MiB，请作为附件发送",
                                            );
                                        const text = new TextDecoder("utf-8", {
                                            fatal: true,
                                        }).decode(await file.arrayBuffer());
                                        onExpand(text);
                                    } catch (cause) {
                                        setError(
                                            `无法展开 ${file.name}：${(cause as Error).message}`,
                                        );
                                    } finally {
                                        setReading(false);
                                    }
                                }}
                            >
                                {reading ? "正在读取…" : "在文本框中显示"} ›
                            </button>
                        ) : (
                            <small>{Math.ceil(file.size / 1024)} KB</small>
                        )}
                    </div>
                </>
            )}
            <button
                type="button"
                className="composer-remove-attachment"
                disabled={disabled || reading}
                aria-label={`移除附件 ${file.name}`}
                onClick={onRemove}
            >
                <CloseIcon size={12} />
            </button>
            {error && (
                <p role="alert" className="composer-attachment-error">
                    {error}
                </p>
            )}
        </div>
    );
}
