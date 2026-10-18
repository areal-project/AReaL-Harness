import { useLayoutEffect, useRef, useState } from "react";
import { Check, MousePointer2, SlidersHorizontal, Square, X } from "lucide-react";
import { Button } from "./components/ui/button.js";
import type { BrowserAnnotation } from "./browserAnnotations.js";
import "./BrowserRegionAnnotation.css";

export interface RegionDraft {
    capture: {
        captureId: string;
        projectId: string;
        threadId: string;
        pageId: string;
        coreInstanceId: string;
        pageGeneration: number;
        documentEpoch: number;
        controlEpoch: number;
        viewportRevision: number;
        capturedAt: string;
        url: string;
        imageBase64: string;
        frameEvidence?: { id: string; loaderId: string; origin: string }[];
        viewport: {
            width: number;
            height: number;
            scrollX: number;
            scrollY: number;
            pageZoom: number;
            guiZoom: number;
            deviceScaleFactor: number;
            nativeBounds: { x: number; y: number; width: number; height: number };
            bitmapWidth: number;
            bitmapHeight: number;
        };
    };
    comment: string;
    region: { x: number; y: number; width: number; height: number } | null;
    point?: { x: number; y: number };
    mode?: "region" | "element";
    element?: {
        elementId: string;
        evidenceRef: string;
        role: string;
        name: string;
        bounds: { x: number; y: number; width: number; height: number };
        pageGeneration: number;
        documentEpoch: number;
        controlEpoch: number;
        frameId: string;
        sourceMapping: string;
    };
    unavailableReason?: string;
}

export function BrowserRegionAnnotation({
    draft,
    busy,
    notes,
    nextNumber,
    onChange,
    onCancel,
    onStage,
    onSelectElement,
}: {
    draft: RegionDraft;
    busy: boolean;
    notes: BrowserAnnotation[];
    nextNumber: number;
    onChange: (draft: RegionDraft) => void;
    onCancel: () => void;
    onStage: (draft: RegionDraft) => void;
    onSelectElement: (point: { x: number; y: number }) => void;
}) {
    const host = useRef<HTMLDivElement>(null),
        image = useRef<HTMLImageElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [dragging, setDragging] = useState(false),
        [details, setDetails] = useState(false);
    const { bitmapWidth, bitmapHeight } = draft.capture.viewport;
    useLayoutEffect(() => {
        const measure = () => {
            const width = Math.min(
                host.current!.clientWidth,
                (host.current!.clientHeight * bitmapWidth) / bitmapHeight,
            );
            setSize({ width, height: (width * bitmapHeight) / bitmapWidth });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(host.current!);
        measure();
        return () => observer.disconnect();
    }, [bitmapWidth, bitmapHeight]);
    useLayoutEffect(() => {
        if (draft.region && !busy && !dragging) input.current?.focus();
    }, [!!draft.region, busy, details, dragging]);
    const point = (clientX: number, clientY: number) => {
        const bounds = image.current?.getBoundingClientRect();
        if (!bounds?.width || !bounds.height) return null;
        // 只换算一次 CSS 与截图位图坐标；缩放和 DPR 已包含在原生截图中。
        return {
            x: Math.min(
                bitmapWidth - 1,
                Math.round(
                    Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * bitmapWidth,
                ),
            ),
            y: Math.min(
                bitmapHeight - 1,
                Math.round(
                    Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)) * bitmapHeight,
                ),
            ),
        };
    };
    const move = (clientX: number, clientY: number) => {
        const end = point(clientX, clientY);
        if (!end || !start.current) return;
        onChange({
            ...draft,
            region: {
                x: Math.min(start.current.x, end.x),
                y: Math.min(start.current.y, end.y),
                width: Math.abs(end.x - start.current.x),
                height: Math.abs(end.y - start.current.y),
            },
            point: end,
            element: undefined,
        });
    };
    const region = draft.region;
    const setCoordinate = (name: "x" | "y" | "width" | "height", raw: number) => {
        const next = {
            ...(region ?? { x: 0, y: 0, width: bitmapWidth, height: bitmapHeight }),
            [name]: Math.max(0, Math.round(raw) || 0),
        };
        next.x = Math.min(next.x, bitmapWidth - 1);
        next.y = Math.min(next.y, bitmapHeight - 1);
        next.width = Math.min(next.width, bitmapWidth - next.x);
        next.height = Math.min(next.height, bitmapHeight - next.y);
        onChange({
            ...draft,
            region: next,
            point: { x: next.x + next.width / 2, y: next.y + next.height / 2 },
            mode: "region",
            element: undefined,
        });
    };
    const scale = size.width / bitmapWidth;
    const anchor =
        draft.point ??
        (region
            ? { x: region.x + region.width / 2, y: region.y + region.height / 2 }
            : { x: 0, y: 0 });
    const editorWidth = Math.min(268, Math.max(0, size.width - 8));
    const markerX = anchor.x * scale;
    const editorLeft =
        markerX + 12 + editorWidth <= size.width - 4
            ? markerX + 12
            : Math.max(4, markerX - editorWidth - 12);
    // 两侧空间都不足时放到标记下方，保持编号可见。
    const editorBelow = editorLeft <= markerX + 11 && editorLeft + editorWidth >= markerX - 11;
    const confirm = () => {
        if (!busy && region?.width && region.height && draft.comment.trim()) onStage(draft);
    };
    return (
        <div
            ref={host}
            className="browser-region-annotation shared-browser-annotation"
            role="region"
            aria-label="冻结截图区域标注"
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!busy) onCancel();
                }
            }}
        >
            <div className="browser-region-image-wrap" style={size}>
                <img
                    ref={image}
                    alt="用于选择区域的冻结页面截图"
                    draggable={false}
                    src={`data:image/png;base64,${draft.capture.imageBase64}`}
                    onPointerDown={(event) => {
                        if (busy || region) return;
                        const origin = point(event.clientX, event.clientY);
                        if (!origin) return;
                        event.preventDefault();
                        if (draft.mode === "element") {
                            onSelectElement(origin);
                            return;
                        }
                        start.current = origin;
                        setDragging(true);
                        event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                        if (dragging) move(event.clientX, event.clientY);
                    }}
                    onPointerUp={(event) => {
                        const end = point(event.clientX, event.clientY);
                        if (start.current && end) {
                            if (end.x === start.current.x || end.y === start.current.y)
                                onChange({ ...draft, region: null });
                            else move(event.clientX, event.clientY);
                        }
                        start.current = null;
                        setDragging(false);
                    }}
                    onPointerCancel={() => {
                        start.current = null;
                        setDragging(false);
                    }}
                />
                {notes
                    .filter((note) => note.captureId === draft.capture.captureId)
                    .map((note) => (
                        <span
                            key={note.id}
                            className="browser-annotation-marker"
                            aria-label={`已确认标注 ${notes.indexOf(note) + 1}`}
                            style={{
                                left: (note.point?.x ?? note.region.x) * scale,
                                top: (note.point?.y ?? note.region.y) * scale,
                            }}
                        >
                            {notes.indexOf(note) + 1}
                        </span>
                    ))}
                {region && (
                    <>
                        <div
                            className="browser-region-selection"
                            aria-hidden="true"
                            style={{
                                left: `${(100 * region.x) / bitmapWidth}%`,
                                top: `${(100 * region.y) / bitmapHeight}%`,
                                width: `${(100 * region.width) / bitmapWidth}%`,
                                height: `${(100 * region.height) / bitmapHeight}%`,
                            }}
                        />
                        <span
                            className="browser-annotation-marker"
                            aria-hidden="true"
                            style={{ left: anchor.x * scale, top: anchor.y * scale }}
                        >
                            {nextNumber}
                        </span>
                        {!dragging && (
                            <div
                                className={`browser-annotation-editor ${details ? "expanded" : ""}`}
                                role="dialog"
                                aria-label="编辑当前标注"
                                style={{
                                    left: editorLeft,
                                    top: Math.max(
                                        4,
                                        Math.min(
                                            anchor.y * scale + (editorBelow ? 16 : -20),
                                            size.height - (details ? 300 : 110),
                                        ),
                                    ),
                                }}
                            >
                                <div className="browser-annotation-editor-row">
                                    <button
                                        type="button"
                                        aria-label="展开批注编辑"
                                        aria-expanded={details}
                                        onClick={() => setDetails(!details)}
                                    >
                                        <SlidersHorizontal size={15} />
                                    </button>
                                    {!details ? (
                                        <textarea
                                            ref={input}
                                            rows={1}
                                            aria-label="标注意见"
                                            placeholder={`批注 ${nextNumber}`}
                                            maxLength={4000}
                                            value={draft.comment}
                                            disabled={busy}
                                            onChange={(event) =>
                                                onChange({ ...draft, comment: event.target.value })
                                            }
                                            onKeyDown={(event) => {
                                                if (
                                                    event.key === "Enter" &&
                                                    !event.shiftKey &&
                                                    !event.nativeEvent.isComposing
                                                ) {
                                                    event.preventDefault();
                                                    confirm();
                                                }
                                            }}
                                        />
                                    ) : (
                                        <span>批注 {nextNumber}</span>
                                    )}
                                    {!details && (
                                        <button
                                            type="button"
                                            className="browser-annotation-confirm"
                                            aria-label="加入聊天草稿"
                                            title="确认批注，加入 Composer"
                                            disabled={
                                                busy ||
                                                !region.width ||
                                                !region.height ||
                                                !draft.comment.trim()
                                            }
                                            onClick={confirm}
                                        >
                                            <Check size={14} />
                                        </button>
                                    )}
                                </div>
                                {details && (
                                    <>
                                        <small>
                                            {draft.element
                                                ? `${draft.element.role} · ${draft.element.name}`
                                                : "区域标注"}
                                        </small>
                                        <textarea
                                            ref={input}
                                            aria-label="标注意见"
                                            value={draft.comment}
                                            disabled={busy}
                                            maxLength={4000}
                                            placeholder="描述想调整的内容…"
                                            onChange={(event) =>
                                                onChange({ ...draft, comment: event.target.value })
                                            }
                                            onKeyDown={(event) => {
                                                if (
                                                    event.key === "Enter" &&
                                                    (event.metaKey || event.ctrlKey) &&
                                                    !event.nativeEvent.isComposing
                                                ) {
                                                    event.preventDefault();
                                                    confirm();
                                                }
                                            }}
                                        />
                                        <div className="browser-annotation-editor-actions">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                disabled={busy}
                                                onClick={() =>
                                                    onChange({
                                                        ...draft,
                                                        region: null,
                                                        element: undefined,
                                                        comment: "",
                                                    })
                                                }
                                            >
                                                取消此条
                                            </Button>
                                            <button
                                                type="button"
                                                className="browser-annotation-confirm"
                                                aria-label="加入聊天草稿"
                                                disabled={busy || !draft.comment.trim()}
                                                onClick={confirm}
                                            >
                                                <Check size={14} />
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
            <div className="browser-annotation-context" role="status">
                {busy
                    ? "正在读取当前选区…"
                    : draft.unavailableReason ||
                      (region
                          ? "确认后加入 Composer；仅分享选区截图"
                          : draft.mode === "element"
                            ? "点选元素添加批注；截图已冻结"
                            : "拖动框选区域；截图已冻结")}
            </div>
            <div className="browser-annotation-dock" role="group" aria-label="标注工具栏">
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="点选元素"
                    aria-pressed={draft.mode === "element"}
                    disabled={busy || !!draft.capture.frameEvidence}
                    onClick={() =>
                        onChange({
                            ...draft,
                            mode: "element",
                            region: null,
                            element: undefined,
                            comment: "",
                        })
                    }
                >
                    <MousePointer2 size={16} />
                </Button>
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="框选区域"
                    aria-pressed={draft.mode === "region"}
                    disabled={busy}
                    onClick={() =>
                        onChange({
                            ...draft,
                            mode: "region",
                            region: null,
                            element: undefined,
                            comment: "",
                        })
                    }
                >
                    <Square size={16} />
                </Button>
                <span>{notes.length} 条标注</span>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-expanded={details}
                    disabled={busy}
                    onClick={() => setDetails(!details)}
                >
                    坐标
                </Button>
                <Button type="button" size="sm" disabled={busy || !!region} onClick={onCancel}>
                    完成
                </Button>
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="退出标注"
                    disabled={busy}
                    onClick={onCancel}
                >
                    <X size={15} />
                </Button>
            </div>
            {details && (
                <fieldset className="browser-region-coordinates browser-annotation-coordinate-panel">
                    <legend>区域位置（截图像素，键盘可调）</legend>
                    {(["x", "y", "width", "height"] as const).map((name) => (
                        <label key={name}>
                            {name}
                            <input
                                type="number"
                                min={0}
                                max={name === "x" || name === "width" ? bitmapWidth : bitmapHeight}
                                disabled={busy}
                                value={region?.[name] ?? ""}
                                onChange={(event) =>
                                    setCoordinate(name, Number(event.target.value))
                                }
                            />
                        </label>
                    ))}
                </fieldset>
            )}
        </div>
    );
}
