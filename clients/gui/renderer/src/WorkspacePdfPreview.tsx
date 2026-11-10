import { useEffect, useRef, useState } from "react";
import { currentErrorText } from "./errors/currentErrorText.js";
import { errorText } from "./errors/errorCopy.js";
import { getDocument, PDFWorker, type PDFDocumentProxy } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.mjs?worker";
import { Button } from "./components/ui/button.js";
import { useI18n } from "./i18n/IntlProvider.js";
import type { PlatformServices, WorkspaceImage } from "./services.js";

type PdfState =
  | { phase: "loading" }
  | { phase: "ready"; document: PDFDocumentProxy }
  | { phase: "failed"; message: string };

export function WorkspacePdfPreview({
  projectId,
  path,
  fileOpen,
}: {
  projectId: string;
  path: string;
  fileOpen?: PlatformServices["fileOpen"];
}) {
  const { t } = useI18n();
  const [state, setState] = useState<PdfState>({ phase: "loading" });
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [pageError, setPageError] = useState("");
  const [rendering, setRendering] = useState(false);
  const [pageText, setPageText] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    let worker: PDFWorker | undefined;
    let port: Worker | undefined;
    let loading: ReturnType<typeof getDocument> | undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      const release = () => {
        worker?.destroy();
        port?.terminate();
      };
      if (loading) void loading.destroy().then(release, release);
      else release();
    };
    setState({ phase: "loading" });
    setPageNumber(1);
    setPageText("");
    void (async () => {
      if (!fileOpen) throw new Error(t("resources.pdfDesktop"));
      const result = await fileOpen({ operation: "readPdf", projectId, path });
      if (!active) return;
      port = new PdfWorker();
      worker = PDFWorker.create({ port });
      const assets = new URL("./pdf-assets/", window.location.href).href;
      loading = getDocument({
        data: (result as WorkspaceImage).bytes,
        worker,
        enableXfa: false,
        useSystemFonts: true,
        cMapUrl: assets + "cmaps/",
        standardFontDataUrl: assets + "standard_fonts/",
        wasmUrl: assets + "wasm/",
        iccUrl: assets + "iccs/",
        maxImageSize: 16_000_000,
      });
      const document = await loading.promise;
      if (active) setState({ phase: "ready", document });
    })().catch((cause: Error) => {
      if (active) setState({ phase: "failed", message: currentErrorText(cause) });
      dispose();
    });
    return () => {
      active = false;
      dispose();
    };
  }, [projectId, path, fileOpen]);
  useEffect(() => {
    if (state.phase !== "ready" || !canvas.current) return;
    const element = canvas.current;
    let active = true;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    setPageError("");
    setPageText("");
    setRendering(true);
    void (async () => {
      const page = await state.document.getPage(pageNumber);
      if (!active) return;
      const viewport = page.getViewport({ scale });
      const density = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
      );
      element.width = Math.max(1, Math.floor(viewport.width * density));
      element.height = Math.max(1, Math.floor(viewport.height * density));
      element.style.width = `${viewport.width}px`;
      element.style.height = `${viewport.height}px`;
      render = page.render({
        canvas: element,
        canvasContext: element.getContext("2d")!,
        viewport,
        transform: [density, 0, 0, density, 0, 0],
      });
      await render.promise;
      const text = await page.getTextContent();
      if (active) setPageText(text.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    })()
      .catch((cause: Error) => {
        if (active) setPageError(errorText(t, cause));
      })
      .finally(() => {
        if (active) setRendering(false);
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [state, pageNumber, scale]);
  if (state.phase === "loading")
    return (
      <p role="status" className="p-3 text-ui-sm text-foreground-subtle">
        {t("common.loading")}
      </p>
    );
  if (state.phase === "failed")
    return (
      <p role="alert" className="p-3 text-ui-sm text-destructive">
        {t("resources.pdfFailed", { error: state.message })}
      </p>
    );
  return (
    <section className="flex min-h-0 flex-col" aria-label={t("resources.pdfPreview")}>
      <div className="flex items-center gap-2 border-b border-border p-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={pageNumber === 1}
          onClick={() => setPageNumber(pageNumber - 1)}
        >
          {t("resources.previousPage")}
        </Button>
        <span role="status" className="text-ui-sm">
          {t("resources.pdfPage", { page: pageNumber, total: state.document.numPages })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={pageNumber === state.document.numPages}
          onClick={() => setPageNumber(pageNumber + 1)}
        >
          {t("resources.nextPage")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={scale <= 0.5}
          onClick={() => setScale(scale - 0.25)}
          aria-label={t("resources.zoomOut")}
        >
          −
        </Button>
        <span className="text-ui-sm">{Math.round(scale * 100)}%</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={scale >= 2}
          onClick={() => setScale(scale + 0.25)}
          aria-label={t("resources.zoomIn")}
        >
          +
        </Button>
      </div>
      {pageError && (
        <p role="alert" className="p-3 text-ui-sm text-destructive">
          {t("resources.pdfFailed", { error: pageError })}
        </p>
      )}
      <div className="overflow-auto p-3" aria-busy={rendering}>
        <canvas
          ref={canvas}
          aria-label={t("resources.pdfPage", { page: pageNumber, total: state.document.numPages })}
        />
        <p className="sr-only">{pageText}</p>
      </div>
    </section>
  );
}
