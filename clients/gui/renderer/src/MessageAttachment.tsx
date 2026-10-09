import { useEffect, useState } from "react";
import { CloseIcon as XIcon } from "./interfaceIcons.js";
import { Attachment, AttachmentInfo, AttachmentPreview, AttachmentRemove } from "./components/ai-elements/attachments.js";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./components/ui/dialog.js";
import type { Action, Data } from "./services.js";
import { DocumentPanelIcon } from "./app-shell/panelIcons.js";
import { ActivityIcon } from "./ActivityIcon.js";

function downloadMedia(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
}

/** ZCode's attachment tile, with Core supplying sent media bytes. */
function AttachmentTile({ name, mime, url, onRemove, sent = false, compact = false }: {
  name: string; mime: string; url: string; onRemove?: () => void; sent?: boolean; compact?: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const image = mime.startsWith("image/");
  const open = url ? () => {
    if (image) setPreviewOpen(true);
    else {
      downloadMedia(url, name);
    }
  } : undefined;
  return <>
    {compact ? <button type="button" className="task-resource-row" onClick={open} aria-label={image ? `预览图片 ${name}` : `下载附件 ${name}`}>
      {image ? <img className="task-resource-thumbnail" src={url} alt="" /> : <DocumentPanelIcon />}
      <span className="task-resource-agent-body"><span>{name}</span><small className="task-resource-description">{image ? "参考图片" : "用户附件"}</small></span><ActivityIcon kind="chevron" size={14} />
    </button> : <Attachment
      variant={image ? "grid" : "inline"}
      data={{ id: name, type: "file", filename: name, mediaType: mime, url }}
      onRemove={onRemove}
      data-message-attachment={image ? "image" : "file"}
      className={image
        ? `${sent ? "size-20 rounded-xl" : "size-12 rounded-lg"} overflow-hidden border border-border bg-surface p-0`
        : "h-10 w-fit max-w-full min-w-0 rounded-lg border border-border bg-surface px-2"}
    >
      {image ? <AttachmentPreview className="size-full rounded-none" /> : <>
        <AttachmentPreview />
        <AttachmentInfo className="max-w-40 text-ui-base" />
      </>}
      {open && <button type="button" onClick={open}
        aria-label={image ? `预览图片 ${name}` : `下载附件 ${name}`}
        className="absolute inset-0 rounded-[inherit] focus-visible:-outline-offset-2" />}
      {onRemove ? <AttachmentRemove placement="corner" size="icon" variant="default" alwaysVisible
        aria-label={`移除附件 ${name}`} label={`移除附件 ${name}`}
        className="absolute right-0.5 top-0.5 z-10 size-4 rounded-full bg-background p-0 text-foreground opacity-100">
        <XIcon className="size-3" />
      </AttachmentRemove> : null}
    </Attachment>}
    {previewOpen ? <Dialog open onOpenChange={setPreviewOpen}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}
        className="h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none place-items-center overflow-hidden border-0 bg-transparent p-10 shadow-none [app-region:no-drag]">
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <Button type="button" variant="outline" size="sm" aria-label={`下载附件 ${name}`} className="absolute right-16 top-4 z-10" onClick={() => downloadMedia(url, name)}>下载</Button>
        <DialogClose render={<Button type="button" variant="ghost" size="icon-md" aria-label="关闭图片预览"
          className="absolute right-4 top-4 z-10 rounded-full border border-border bg-background text-foreground" />}><XIcon /></DialogClose>
        {url ? <img src={url} alt={name} className="max-h-full max-w-full rounded-xl border border-border bg-background object-contain shadow-2xl" /> : null}
      </DialogContent>
    </Dialog> : null}
  </>;
}

export function DraftAttachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return <AttachmentTile name={file.name} mime={file.type} url={url} onRemove={onRemove} />;
}

export function SentAttachment({ part, projectId, threadId, action, compact = false }: {
  part: Data; projectId: string; threadId: string; action: Action; compact?: boolean;
}) {
  const [media, setMedia] = useState<{ url: string; mime: string } | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setFailure("");
    void action("media", { projectId, threadId, operation: "read", uri: part.url ?? part.uri })
      .then((value) => {
        if (!active) return;
        const blobMime = value.mime ?? "application/octet-stream";
        const displayMime = part.type === "image" && !blobMime.startsWith("image/")
          ? "image/*" : blobMime;
        objectUrl = URL.createObjectURL(new Blob([value.bytes], { type: blobMime }));
        setMedia({ url: objectUrl, mime: displayMime });
      })
      .catch((cause) => { if (active) setFailure(cause instanceof Error ? cause.message : "读取附件失败"); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [part.url, part.uri, projectId, threadId, action]);
  const name = part.name ?? (part.type === "image" ? "消息图片" : "附件");
  if (failure) return <span role="status" className="text-ui-sm text-foreground-subtle">{failure}</span>;
  if (!media) return <span className="text-ui-sm text-foreground-subtle">读取附件…</span>;
  if (part.type === "audio" && !compact) return <div className="flex flex-wrap items-center gap-2"><audio src={media.url} controls /><Button variant="outline" size="sm" aria-label={`下载附件 ${name}`} onClick={() => downloadMedia(media.url, name)}>下载</Button></div>;
  return <AttachmentTile name={name} mime={media.mime} url={media.url} sent compact={compact} />;
}
