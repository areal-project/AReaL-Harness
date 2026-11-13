import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { mermaid } from "@streamdown/mermaid";
import { observeResize } from "@areal/ui/observe-resize";
import { Download, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useI18n } from "../../i18n/IntlProvider.js";
import { Button } from "../ui/button.js";
import { ControlHintTooltip } from "../../ControlHintTooltip.js";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog.js";

type DiagramImage = { url: string; width: number; height: number };
export type DiagramSelection = {
  code: string;
  trigger: HTMLButtonElement;
  index: number;
  scope: string;
};
type DiagramState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; image: DiagramImage };

export function DiagramReader({
  code,
  theme,
  returnFocus,
}: {
  code: string;
  theme: "light" | "dark";
  returnFocus: ComponentProps<typeof DialogContent>["finalFocus"];
}) {
  const { t } = useI18n();
  const id = useId();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DiagramState>({ status: "loading" });
  useEffect(() => {
    let disposed = false;
    let url: string | undefined;
    setState({ status: "loading" });
    const render = async () => {
      try {
        const instance = mermaid.getMermaid({
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "strict",
          flowchart: { htmlLabels: false },
          fontFamily: getComputedStyle(document.body).fontFamily,
        });
        const { svg } = await instance.render(
          `diagram-reader-${id.replace(/[^a-zA-Z0-9]/g, "")}-${attempt}`,
          code,
        );
        if (disposed) return;
        const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
        const [, , width, height] = (root.getAttribute("viewBox") ?? "")
          .split(/[\s,]+/)
          .map(Number);
        if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
          setState({ status: "failed" });
          return;
        }
        // 独立图片文档避免与内联 SVG 的 ID 冲突，也不执行图内脚本或链接。
        url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setState({ status: "ready", image: { url, width, height } });
      } catch {
        if (!disposed) setState({ status: "failed" });
      }
    };
    void render();
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [code, theme, id, attempt]);

  return (
    <DialogContent
      finalFocus={returnFocus}
      className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-3 p-4"
    >
      <DialogHeader className="pr-10">
        <DialogTitle>{t("content.diagramTitle")}</DialogTitle>
        <DialogDescription>{t("content.diagramNavigation")}</DialogDescription>
      </DialogHeader>
      {state.status === "loading" && <p role="status">{t("content.diagramLoading")}</p>}
      {state.status === "failed" && (
        <div role="status">
          <p>{t("content.diagramUnavailable")}</p>
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t("content.diagramRetry")}
          </Button>
        </div>
      )}
      {state.status === "ready" && <DiagramCanvas image={state.image} />}
    </DialogContent>
  );
}

function DiagramCanvas({ image }: { image: DiagramImage }) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [manualScale, setManualScale] = useState<number | null>(null);
  const center = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fit = Math.min(
    1,
    Math.max(1, size.width - 32) / image.width,
    Math.max(1, size.height - 32) / image.height,
  );
  const scale = manualScale ?? fit;
  const minimum = Math.min(fit, 0.1);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    return observeResize(element, measure);
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollLeft = center.current
      ? Math.max(16, (element.clientWidth - image.width * scale) / 2) +
        center.current.x * scale -
        element.clientWidth / 2
      : 0;
    element.scrollTop = center.current
      ? Math.max(16, (element.clientHeight - image.height * scale) / 2) +
        center.current.y * scale -
        element.clientHeight / 2
      : 0;
  }, [scale]);

  const zoomTo = (value: number | null) => {
    const element = viewport.current;
    center.current =
      value !== null && element
        ? {
            x:
              (element.scrollLeft +
                element.clientWidth / 2 -
                Math.max(16, (element.clientWidth - image.width * scale) / 2)) /
              scale,
            y:
              (element.scrollTop +
                element.clientHeight / 2 -
                Math.max(16, (element.clientHeight - image.height * scale) / 2)) /
              scale,
          }
        : null;
    setManualScale(value === null ? null : Math.max(minimum, Math.min(4, value)));
  };
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label={t("content.diagramZoom")}
      >
        <ControlHintTooltip title={t("content.diagramZoomOut")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("content.diagramZoomOut")}
            disabled={scale <= minimum}
            onClick={() => zoomTo(scale / 1.25)}
          >
            <ZoomOut />
          </Button>
        </ControlHintTooltip>
        <output className="min-w-12 text-center text-ui-sm tabular-nums" aria-live="polite">
          {Math.round(scale * 100)}%
        </output>
        <ControlHintTooltip title={t("content.diagramZoomIn")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("content.diagramZoomIn")}
            disabled={scale >= 4}
            onClick={() => zoomTo(scale * 1.25)}
          >
            <ZoomIn />
          </Button>
        </ControlHintTooltip>
        <Button variant="ghost" size="sm" onClick={() => zoomTo(null)}>
          <Maximize2 />
          {t("content.diagramFit")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => zoomTo(1)}>
          {t("content.diagramActualSize")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            const link = document.createElement("a");
            link.href = image.url;
            link.download = "diagram.svg";
            link.click();
          }}
        >
          <Download />
          {t("content.diagramDownload")}
        </Button>
      </div>
      <div
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label={t("content.diagramCanvas")}
        className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-panel border border-border bg-background outline-offset-2"
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (!["+", "=", "-", "0", "1"].includes(event.key)) return;
          event.preventDefault();
          if (event.key === "0") zoomTo(null);
          else if (event.key === "1") zoomTo(1);
          else zoomTo(event.key === "-" ? scale / 1.25 : scale * 1.25);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType === "touch") return;
          const element = event.currentTarget;
          element.focus({ preventScroll: true });
          element.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: element.scrollLeft,
            top: element.scrollTop,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
          event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <div
          className="grid place-items-center p-4"
          style={{
            width: Math.max(size.width, image.width * scale + 32),
            height: Math.max(size.height, image.height * scale + 32),
          }}
        >
          <img
            src={image.url}
            alt={t("content.diagramPreview")}
            draggable={false}
            className="pointer-events-none max-w-none select-none"
            style={{ width: image.width * scale, height: image.height * scale }}
          />
        </div>
      </div>
    </>
  );
}
