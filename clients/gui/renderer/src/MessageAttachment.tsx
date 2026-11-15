import { usePlatformReads, useReadOnly, type MediaOwner } from "./PlatformReadContext.js";
import { currentErrorText } from "./errors/currentErrorText.js";
import { TitleTooltip } from "@areal/ui";
import { observeResize } from "@areal/ui/observe-resize";
import type { SnapShotSource } from "./services.js";
import { SnapShotAttachment } from "./snapshots/SnapShotAttachment.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useRef, useState } from "react";
import { ImageAnnotationList } from "./ImageAnnotationViews.js";
import type { SentImageAnnotation } from "./imageAnnotations.js";
import { CloseIcon as XIcon } from "./interfaceIcons.js";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
} from "./components/ai-elements/attachments.js";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./components/ui/dialog.js";
import type { Action, Data } from "./services.js";
import { DocumentPanelIcon } from "./app-shell/panelIcons.js";
import { ActivityIcon } from "./ActivityIcon.js";

function downloadMedia(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Viewing state belongs to this dialog, never to the task or media reader. */
function ImageInspection({ url, name }: { url: string; name: string }) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [space, setSpace] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setSpace({ width: el.clientWidth, height: el.clientHeight });
    measure();
    return observeResize(el, measure);
  }, []);
  const fit =
    natural.width && space.width
      ? Math.min(1, space.width / natural.width, space.height / natural.height)
      : 1;
  const scale = zoom ?? fit;
  const changeZoom = (factor: number) => setZoom(Math.min(4, Math.max(0.01, scale * factor)));
  const pannable = natural.width * scale > space.width || natural.height * scale > space.height;
  return (
    <>
      <div
        ref={viewport}
        className="image-inspection-viewport"
        role="region"
        aria-label={t("chat.image.viewport")}
        tabIndex={0}
        data-pannable={pannable}
        onPointerDown={(event) => {
          if (!pannable || event.button !== 0 || event.pointerType !== "mouse") return;
          event.preventDefault();
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div className="image-inspection-canvas">
          <img
            src={url}
            alt={name}
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            style={
              natural.width
                ? { width: natural.width * scale, height: natural.height * scale }
                : undefined
            }
          />
        </div>
      </div>
      <div className="image-inspection-controls" role="group" aria-label={t("chat.image.zoom")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("chat.image.zoomOut")}
          disabled={scale <= 0.01}
          onClick={() => changeZoom(1 / 1.25)}
        >
          −
        </Button>
        <output aria-label={t("chat.image.zoomLevel")}>{Math.round(scale * 100)}%</output>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("chat.image.zoomIn")}
          disabled={scale >= 4}
          onClick={() => changeZoom(1.25)}
        >
          +
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("chat.image.actualSize")}
          onClick={() => setZoom(1)}
        >
          100%
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={zoom === null}
          onClick={() => setZoom(null)}
        >
          {t("chat.image.fit")}
        </Button>
      </div>
    </>
  );
}

/** ZCode's attachment tile, with Core supplying sent media bytes. */
function AttachmentTile({
  name,
  mime,
  url,
  onRemove,
  sent = false,
  compact = false,
  annotation,
}: {
  name: string;
  mime: string;
  url: string;
  onRemove?: () => void;
  sent?: boolean;
  compact?: boolean;
  annotation?: SentImageAnnotation;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const image = mime.startsWith("image/");
  const open = url
    ? () => {
        if (image) setPreviewOpen(true);
        else {
          downloadMedia(url, name);
        }
      }
    : undefined;
  return (
    <>
      {compact ? (
        <Button
          unstyled
          data-slot={undefined}
          type="button"
          className="task-resource-row"
          onClick={open}
          aria-label={image ? `预览图片 ${name}` : `下载附件 ${name}`}
        >
          {image ? (
            url ? (
              <img className="task-resource-thumbnail" src={url} alt="" />
            ) : (
              <span className="task-resource-thumbnail" aria-hidden="true" />
            )
          ) : (
            <DocumentPanelIcon />
          )}
          <span className="task-resource-agent-body">
            <span>{name}</span>
            <small className="task-resource-description">{image ? "参考图片" : "用户附件"}</small>
          </span>
          <ActivityIcon kind="chevron" size={14} />
        </Button>
      ) : (
        <Attachment
          variant={image ? "grid" : "inline"}
          data={{ id: name, type: "file", filename: name, mediaType: mime, url }}
          onRemove={onRemove}
          data-message-attachment={image ? "image" : "file"}
          className={
            image
              ? `${sent ? "size-20 rounded-xl" : "size-12 rounded-lg"} overflow-hidden border border-border bg-surface p-0`
              : "h-10 w-fit max-w-full min-w-0 rounded-lg border border-border bg-surface px-2"
          }
        >
          {image ? (
            url ? (
              <AttachmentPreview className="size-full rounded-none" />
            ) : (
              <span className="sr-only">{name}</span>
            )
          ) : (
            <>
              <AttachmentPreview />
              <AttachmentInfo className="max-w-40 text-ui-base" />
            </>
          )}
          {open && (
            <Button
              unstyled
              data-slot={undefined}
              type="button"
              onClick={open}
              aria-label={image ? `预览图片 ${name}` : `下载附件 ${name}`}
              className="absolute inset-0 rounded-[inherit] focus-visible:-outline-offset-2"
            />
          )}
          {onRemove ? (
            <AttachmentRemove
              placement="corner"
              size="icon"
              variant="default"
              alwaysVisible
              aria-label={`移除附件 ${name}`}
              label={`移除附件 ${name}`}
              className="absolute right-0.5 top-0.5 z-10 size-4 rounded-full bg-background p-0 text-foreground opacity-100"
            >
              <XIcon className="size-3" />
            </AttachmentRemove>
          ) : null}
        </Attachment>
      )}
      {previewOpen && (
        <ImagePreview
          name={name}
          url={url}
          annotation={annotation}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}

export function ImagePreview({
  name,
  url,
  annotation,
  onClose,
  onAnnotate,
}: {
  name: string;
  url: string;
  annotation?: SentImageAnnotation;
  onClose: () => void;
  onAnnotate?: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="image-inspection-dialog h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none overflow-hidden border-0 bg-transparent shadow-none [app-region:no-drag]"
      >
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`下载附件 ${name}`}
          className="absolute right-16 top-4 z-10"
          onClick={() => downloadMedia(url, name)}
        >
          下载
        </Button>
        <DialogClose
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭图片预览"
              className="absolute right-4 top-4 z-10 rounded-full border border-border bg-background text-foreground"
            />
          }
        >
          <XIcon />
        </DialogClose>
        {annotation ? (
          <div className="image-preview-body">
            <div className="image-preview-original">
              <img src={url} alt={name} />
              {annotation?.points.map((point, index) => (
                <TitleTooltip key={point.id} title={point.comment}>
                  <span
                    className="browser-annotation-marker"
                    aria-label={`已确认标注 ${index + 1}`}
                    style={{ left: `${point.xPercent}%`, top: `${point.yPercent}%` }}
                  >
                    {index + 1}
                  </span>
                </TitleTooltip>
              ))}
            </div>
            <ImageAnnotationList note={annotation} />
          </div>
        ) : (
          <ImageInspection url={url} name={name} />
        )}
        {onAnnotate && (
          <Button
            type="button"
            className="absolute bottom-4 left-1/2 -translate-x-1/2"
            onClick={onAnnotate}
          >
            标注
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DraftAttachment({ file, onRemove }: { file: File; onRemove?: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return (
    <AttachmentTile
      name={file.name}
      mime={file.type}
      url={url}
      onRemove={onRemove}
      sent={!onRemove}
    />
  );
}

export function SentAttachment({
  part,
  projectId,
  threadId,
  action,
  compact = false,
  annotation,
  onError,
  snapShotSource,
  mediaSource,
}: {
  part: Data;
  projectId: string;
  threadId: string;
  action: Action;
  compact?: boolean;
  annotation?: SentImageAnnotation;
  onError?: (message: string) => void;
  snapShotSource?: SnapShotSource;
  mediaSource?: MediaOwner;
}) {
  const reads = usePlatformReads();
  const source = mediaSource;
  const readOnly = useReadOnly();
  const [media, setMedia] = useState<{ url: string; mime: string } | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    const abort = new AbortController();
    setFailure("");
    setMedia(null);
    const reading = reads
      ? source
        ? reads.media(
            {
              turnId: source.turnId,
              itemId: source.itemId,
              sourceThreadId: source.sourceThreadId,
              uri: part.url ?? part.uri,
            },
            abort.signal,
          )
        : Promise.reject(new Error("Media source unavailable"))
      : action("media", { projectId, threadId, operation: "read", uri: part.url ?? part.uri });
    void reading
      .then((value) => {
        if (!active) return;
        const blobMime = value.mime ?? "application/octet-stream";
        const displayMime =
          part.type === "image" && !blobMime.startsWith("image/") ? "image/*" : blobMime;
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(value.bytes).buffer], { type: blobMime }),
        );
        setMedia({ url: objectUrl, mime: displayMime });
      })
      .catch((cause) => {
        if (active) {
          const message = cause instanceof Error ? currentErrorText(cause) : "读取附件失败";
          setFailure(message);
          onError?.(message);
        }
      });
    return () => {
      active = false;
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    part.url,
    part.uri,
    projectId,
    threadId,
    action,
    onError,
    reads,
    source?.turnId,
    source?.itemId,
    source?.sourceThreadId,
    source?.generation,
  ]);
  const name =
    annotation?.name ??
    part.name ??
    snapShotSource?.windowTitle ??
    (part.type === "image" ? "消息图片" : "附件");
  if (failure)
    return (
      <span role="status" className="text-ui-sm text-foreground-subtle">
        {failure}
      </span>
    );
  if (!media)
    return part.type === "image" || part.type === "file" ? (
      <AttachmentTile
        name={name}
        mime={part.type === "image" ? "image/*" : "application/octet-stream"}
        url=""
        sent
        compact={compact}
      />
    ) : (
      <span className="text-ui-sm text-foreground-subtle">读取附件…</span>
    );
  if (part.type === "audio" && !compact)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <audio src={media.url} controls />
        <Button
          variant="outline"
          size="sm"
          aria-label={`下载附件 ${name}`}
          onClick={() => downloadMedia(media.url, name)}
        >
          下载
        </Button>
      </div>
    );
  if (!readOnly && snapShotSource && part.type === "image")
    return <SnapShotAttachment source={snapShotSource} url={media.url} name={name} />;
  return (
    <AttachmentTile
      name={name}
      mime={media.mime}
      url={media.url}
      sent
      compact={compact}
      annotation={annotation}
    />
  );
}

export function mediaOwner(item: Data, turnId: string, generation?: string): MediaOwner {
  return {
    generation,
    turnId: item.historySource?.turnId ?? turnId,
    itemId: item.historySource?.itemId ?? item.id,
    sourceThreadId: item.historySource?.threadId,
  };
}
