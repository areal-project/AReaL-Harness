import { useRef, useState } from "react";
import type { SnapShotSource } from "@areal/workbench/desktop-contract/snapshots";
import { ScanText, Image as ImageIcon, X } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover.js";
import { ImagePreview } from "../MessageAttachment.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { landSnapShotAnimation, useSnapShotAnimation } from "./animation.js";

// Adapted from T3 Code's SnapShotAttachmentDetails, MIT, Copyright 2026 T3 Tools Inc.
export function SnapShotAttachment({
  source,
  url,
  name,
  id,
  disabled,
  onRemove,
}: {
  source: SnapShotSource;
  url: string;
  name: string;
  id?: string;
  disabled?: boolean;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const animating = useSnapShotAnimation(id);
  const text =
    source.accessibility?.format === "element-tree"
      ? JSON.stringify(source.accessibility, null, 2)
      : source.accessibility?.format === "flat-text"
        ? source.accessibility.text
        : source.accessibleText;
  return (
    <>
      <div
        ref={frame}
        data-testid="snapshot-attachment"
        data-snapshot-id={id}
        className="relative h-28 w-52 max-w-full shrink-0 overflow-hidden rounded-lg border border-border bg-background"
        style={{ visibility: animating ? "hidden" : undefined }}
        aria-hidden={animating || undefined}
      >
        <Button
          unstyled
          type="button"
          data-slot={undefined}
          aria-label={t("snapshots.preview")}
          disabled={disabled || animating}
          className="h-full w-full cursor-zoom-in"
          onClick={() => setPreview(true)}
        >
          <img
            src={url}
            alt={name}
            className="h-full w-full object-cover"
            onLoad={() => {
              if (id && frame.current) void landSnapShotAnimation(id, frame.current, source);
            }}
          />
        </Button>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 bg-linear-to-t from-media-overlay/85 via-media-overlay/55 to-transparent px-2.5 pb-2 pt-6">
          {source.appIconDataUrl ? (
            <img src={source.appIconDataUrl} alt="" className="size-7 shrink-0 rounded-md" />
          ) : (
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-media-overlay-foreground/20 text-ui-xs font-medium text-media-overlay-foreground uppercase">
              {source.appName.slice(0, 1)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-ui-xs font-medium text-media-overlay-foreground">
              <span className="truncate">{source.appName}</span>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      unstyled
                      type="button"
                      className="pointer-events-auto flex size-5 items-center justify-center rounded-sm bg-media-overlay/30 text-media-overlay-foreground"
                      aria-label={t("snapshots.source")}
                      disabled={disabled || animating}
                    />
                  }
                >
                  {text ? <ScanText size={12} /> : <ImageIcon size={12} />}
                </PopoverTrigger>
                <PopoverContent className="max-w-md">
                  <PopoverTitle>{t("snapshots.source")}</PopoverTitle>
                  <pre
                    tabIndex={0}
                    className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-2 text-ui-xs"
                  >
                    {text || t("snapshots.noSource")}
                  </pre>
                </PopoverContent>
              </Popover>
            </div>
            <div className="truncate text-ui-xs text-media-overlay-foreground/70">
              {source.windowTitle || t("snapshots.capturedWindow")}
            </div>
          </div>
        </div>
        {onRemove && (
          <Button
            unstyled
            type="button"
            aria-label={t("snapshots.remove")}
            disabled={disabled || animating}
            className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-media-overlay/65 text-media-overlay-foreground"
            onClick={onRemove}
          >
            <X size={12} />
          </Button>
        )}
      </div>
      {preview && <ImagePreview name={name} url={url} onClose={() => setPreview(false)} />}
    </>
  );
}
