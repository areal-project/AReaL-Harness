import { observeResize } from "@areal/ui/observe-resize";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { ReviewCommentGlyph } from "./interfaceIcons.js";
import { AnnotationNoteEditor } from "./AnnotationNoteEditor.js";
import {
  imageAnnotation,
  setImageAnnotation,
  imagePercent,
  imagePointPosition,
  useImageAnnotationRevision,
  type ImageAnnotationDraft,
  type SentImageAnnotation,
} from "./imageAnnotations.js";
import "./ImageAnnotationViews.css";

export function ImageAnnotationList({ note }: { note: SentImageAnnotation }) {
  return (
    <section
      className="image-annotation-list"
      aria-label={`Image ${note.imageNumber ?? note.attachmentIndex + 1} 标注`}
    >
      <strong>
        Image {note.imageNumber ?? note.attachmentIndex + 1} · {note.name}
      </strong>
      <ol>
        {note.points.map((point) => (
          <li key={point.id}>
            <span>{imagePointPosition(point)}</span> {point.comment}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ImageAnnotationPane({ file, onDone }: { file: File; onDone: () => void }) {
  useImageAnnotationRevision();
  const [url, setUrl] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [failure, setFailure] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const original = useRef<HTMLDivElement>(null);
  const [editorPosition, setEditorPosition] = useState({ left: 4, top: 4, width: 268 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const record = imageAnnotation(file);
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  useEffect(() => {
    const measure = () => {
      if (!host.current || !record?.width) return;
      const width = Math.min(
        host.current.clientWidth - 24,
        (Math.max(0, host.current.clientHeight - 120) * record.width) / record.height,
      );
      setSize({
        width: Math.max(0, width),
        height: Math.max(0, (width * record.height) / record.width),
      });
    };
    measure();
    if (!host.current) return;
    return observeResize(host.current, measure);
  }, [record?.width, record?.height]);
  const update = (value: ImageAnnotationDraft) => setImageAnnotation(file, value);
  const pending = record?.pending.kind !== "idle" ? record?.pending : undefined;
  const point = pending?.point;
  const number =
    pending?.kind === "edit"
      ? (record?.points.findIndex((value) => value.id === point?.id) ?? -1) + 1
      : (record?.points.length ?? 0) + 1;
  const cancel = () => {
    if (record) update({ ...record, pending: { kind: "idle" } });
  };
  const confirm = () => {
    if (!record || !pending || !point?.comment.trim()) return;
    const next = { ...point, comment: point.comment.trim() };
    update({
      ...record,
      points:
        pending.kind === "edit"
          ? record.points.map((value) => (value.id === next.id ? next : value))
          : [...record.points, next],
      pending: { kind: "idle" },
    });
  };
  const displaySize = { width: size.width * zoom, height: size.height * zoom };
  useLayoutEffect(() => {
    const canvas = host.current;
    if (!canvas || !point) return;
    const measure = () => {
      const imageBounds = original.current?.getBoundingClientRect();
      if (!imageBounds) return;
      const canvasBounds = canvas.getBoundingClientRect();
      const width = Math.min(268, Math.max(0, canvas.clientWidth - 8));
      const x = imageBounds.left - canvasBounds.left + point.x * imageBounds.width;
      const y = imageBounds.top - canvasBounds.top + point.y * imageBounds.height;
      const preferredLeft = x + 12 + width <= canvas.clientWidth - 4 ? x + 12 : x - width - 12;
      const left = Math.max(4, Math.min(preferredLeft, canvas.clientWidth - width - 4));
      const below = left <= x + 11 && left + width >= x - 11;
      const top = Math.max(
        4,
        Math.min(y + (below ? 16 : -20), canvas.clientHeight - (expanded ? 220 : 44) - 4),
      );
      setEditorPosition({ left, top, width });
    };
    const disconnect = observeResize(canvas, measure);
    canvas.addEventListener("scroll", measure);
    measure();
    return () => {
      disconnect();
      canvas.removeEventListener("scroll", measure);
    };
  }, [displaySize.width, displaySize.height, point?.x, point?.y, expanded]);
  return (
    <section className="image-annotation-pane" role="region" aria-label="图片标注">
      <header>
        <ReviewCommentGlyph />
        <strong>{file.name}</strong>
        <span>{record?.points.length ?? 0} 条标注</span>
      </header>
      <div className="image-annotation-stage">
        <div className="image-annotation-canvas" ref={host}>
          <div className="image-annotation-scroll-content">
            <div
              className="image-annotation-original"
              ref={original}
              style={record ? displaySize : undefined}
            >
              <img
                src={url}
                alt={`标注图片 ${file.name}`}
                draggable={false}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (!record || pending || (event.key !== "Enter" && event.key !== " ")) return;
                  event.preventDefault();
                  update({
                    ...record,
                    pending: {
                      kind: "new",
                      point: { id: crypto.randomUUID(), x: 0.5, y: 0.5, comment: "" },
                    },
                  });
                }}
                onError={() => setFailure("无法显示这张图片，请移除后重新添加。")}
                onLoad={(event) => {
                  if (!imageAnnotation(file))
                    update({
                      id: crypto.randomUUID(),
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                      points: [],
                      pending: { kind: "idle" },
                    });
                }}
                onClick={(event) => {
                  if (!record || pending) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (
                    !rect.width ||
                    !rect.height ||
                    event.clientX < rect.left ||
                    event.clientX > rect.right ||
                    event.clientY < rect.top ||
                    event.clientY > rect.bottom
                  )
                    return;
                  update({
                    ...record,
                    pending: {
                      kind: "new",
                      point: {
                        id: crypto.randomUUID(),
                        x: (event.clientX - rect.left) / rect.width,
                        y: (event.clientY - rect.top) / rect.height,
                        comment: "",
                      },
                    },
                  });
                }}
              />
              {record?.points.map((value, index) => (
                <div
                  key={value.id}
                  className="browser-annotation-marker image-annotation-marker"
                  style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }}
                >
                  <Button
                    unstyled
                    data-slot={undefined}
                    type="button"
                    className="size-full"
                    aria-label={`已确认标注 ${index + 1}`}
                    title={value.comment}
                    disabled={!!pending}
                    onClick={() =>
                      update({ ...record, pending: { kind: "edit", point: { ...value } } })
                    }
                  >
                    {index + 1}
                  </Button>
                </div>
              ))}
              {point && (
                <span
                  className="browser-annotation-marker"
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                >
                  {number}
                </span>
              )}
            </div>
          </div>
        </div>
        {point && record && (
          <AnnotationNoteEditor
            number={number}
            comment={point.comment}
            expanded={expanded}
            onExpandedChange={setExpanded}
            details={`Image · (x: ${imagePercent(point.x)}%, y: ${imagePercent(point.y)}%)`}
            style={editorPosition}
            onChange={(comment) =>
              update({ ...record, pending: { ...pending!, point: { ...point, comment } } })
            }
            onConfirm={confirm}
            onCancel={cancel}
          />
        )}
      </div>
      {failure && <p role="alert">{failure}</p>}
      <p className="image-annotation-help" role="status">
        {pending ? "请确认或取消当前标注后继续。" : "点击图片添加标注，点击编号修改。"}
      </p>
      {record && record.points.length > 0 && (
        <ol className="image-annotation-draft-list">
          {record.points.map((value, index) => (
            <li key={value.id}>
              <Button
                unstyled
                data-slot={undefined}
                type="button"
                disabled={!!pending}
                onClick={() =>
                  update({ ...record, pending: { kind: "edit", point: { ...value } } })
                }
              >
                {index + 1}. (x: {imagePercent(value.x)}%, y: {imagePercent(value.y)}%){" "}
                {value.comment}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`删除标注 ${index + 1}`}
                disabled={!!pending}
                onClick={() =>
                  update({
                    ...record,
                    points: record.points.filter((item) => item.id !== value.id),
                  })
                }
              >
                ×
              </Button>
            </li>
          ))}
        </ol>
      )}
      <footer>
        <div className="image-annotation-zoom" role="group" aria-label="图片缩放">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="缩小图片"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          >
            −
          </Button>
          <Button size="sm" variant="ghost" aria-label="适应图片" onClick={() => setZoom(1)}>
            适应
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="放大图片"
            disabled={zoom >= 3}
            onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
          >
            +
          </Button>
        </div>
        {pending && (
          <Button size="sm" variant="ghost" onClick={cancel}>
            取消此条
          </Button>
        )}
        <Button size="sm" aria-label="完成标注" disabled={!!pending} onClick={onDone}>
          完成标注
        </Button>
      </footer>
    </section>
  );
}
