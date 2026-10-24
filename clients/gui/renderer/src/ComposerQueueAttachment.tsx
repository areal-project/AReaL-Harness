import { AttachmentCard } from "@areal/ui/wip";
import { useEffect, useState } from "react";
import { ScanText } from "lucide-react";
import { CloseIcon } from "./interfaceIcons.js";
import type { Action, Data } from "./services.js";

/** 保留 Core 上传引用，预览不重新上传附件；只有用户移除时才从编辑输入中移除。 */
export function ComposerQueueAttachment({
    part,
    projectId,
    threadId,
    action,
    disabled,
    onRemove,
}: {
    part: Data;
    projectId: string;
    threadId: string;
    action: Action;
    disabled: boolean;
    onRemove: () => void;
}) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    const name =
        part.name ||
        (part.type === "image" ? "排队图片" : part.type === "audio" ? "排队音频" : "排队附件");
    const read = () => action("media", { projectId, threadId, operation: "read", uri: part.url });
    useEffect(() => {
        if (part.type !== "image") return;
        let active = true,
            preview = "";
        void read()
            .then((result) => {
                if (!active) return;
                preview = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }));
                setUrl(preview);
            })
            .catch((cause) => {
                if (active) setError(cause.message);
            });
        return () => {
            active = false;
            if (preview) URL.revokeObjectURL(preview);
        };
    }, [part.url, projectId, threadId]);
    return (
        <AttachmentCard
            image={part.type === "image"}
            data-testid="composer-queued-attachment"
        >
            {part.type === "image" && url ? (
                <img src={url} alt={name} />
            ) : (
                <>
                    <AttachmentCard.Icon>
                        <ScanText size={22} />
                    </AttachmentCard.Icon>
                    <AttachmentCard.Text>
                        <span>{name}</span>
                    </AttachmentCard.Text>
                </>
            )}
            <AttachmentCard.Remove
                type="button"
                disabled={disabled}
                aria-label={`移除排队附件 ${name}`}
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
}
