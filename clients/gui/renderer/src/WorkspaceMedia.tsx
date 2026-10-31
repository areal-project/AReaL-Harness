import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { FileMenuChevronIcon as ChevronDown, FileReference } from "./interfaceIcons.js";
import { ImagePreview } from "./MessageAttachment.js";
import { useI18n } from "./i18n/IntlProvider.js";
import type {
  FileOpenTargets,
  PlatformServices,
  WorkspaceImage as ImageBytes,
} from "./services.js";

type FileOpen = NonNullable<PlatformServices["fileOpen"]>;

// Agent replies reference generated files by workspace path. Only path-relative
// or absolute local paths qualify; URLs and Core media keep their own handling.
const workspacePath = /^(?:\.\.?\/|\/(?!\/))/;
const inlineImages = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
// Files that the conversation shows as a card. Text formats the file pane can
// read (CSV, SVG) still open there; the rest open in an external application.
const cardTypes: Record<string, string> = {
  pdf: "PDF",
  zip: "ZIP 压缩包",
  gz: "压缩包",
  tgz: "压缩包",
  "7z": "压缩包",
  png: "PNG 图片",
  jpg: "JPEG 图片",
  jpeg: "JPEG 图片",
  gif: "GIF 图片",
  webp: "WebP 图片",
  svg: "SVG 图片",
  csv: "CSV 表格",
  tsv: "TSV 表格",
  xlsx: "Excel 表格",
  xls: "Excel 表格",
  docx: "Word 文档",
  doc: "Word 文档",
  pptx: "PowerPoint 演示文稿",
  ppt: "PowerPoint 演示文稿",
  mp4: "视频",
  mov: "视频",
  webm: "视频",
  mp3: "音频",
  wav: "音频",
};
const paneReadable = new Set(["csv", "tsv", "svg"]);

function extension(path: string) {
  return /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
}
function fileName(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}
export function isWorkspaceImagePath(path: string) {
  return workspacePath.test(path) && inlineImages.has(extension(path));
}
export function workspaceFileCardType(path: string) {
  return workspacePath.test(path) ? cardTypes[extension(path)] : undefined;
}
/** Binary files the workspace file pane cannot show open in an external application. */
export function opensOutside(path: string) {
  return !!workspaceFileCardType(path) && !paneReadable.has(extension(path));
}

function errorText(cause: unknown) {
  return (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}

/** A workspace image read through the desktop host, never by a renderer file URL. */
export function WorkspaceImage({
  path,
  alt,
  projectId,
  fileOpen,
}: {
  path: string;
  alt: string;
  projectId: string;
  fileOpen: FileOpen;
}) {
  const { t } = useI18n();
  const [image, setImage] = useState<{ url: string } | { error: string }>();
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setImage(undefined);
    void fileOpen({ operation: "readImage", projectId, path })
      .then((value) => {
        const { bytes, mimeType } = value as ImageBytes;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
        if (active) setImage({ url: objectUrl });
        else URL.revokeObjectURL(objectUrl);
      })
      .catch((cause) => {
        if (active) setImage({ error: errorText(cause) });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileOpen, projectId, path]);
  const name = alt || fileName(path);
  if (!image)
    return (
      <span className="text-ui-sm text-foreground-subtle">
        {t("content.workspaceImage.loading")}
      </span>
    );
  if ("error" in image)
    return (
      <WorkspaceFileCard
        path={path}
        label={alt}
        projectId={projectId}
        fileOpen={fileOpen}
        notice={image.error}
      />
    );
  return (
    <>
      <Button
        unstyled
        type="button"
        className="block max-w-full cursor-zoom-in overflow-hidden rounded-xl border border-border bg-surface"
        aria-label={t("content.workspaceImage.preview", { name })}
        title={path.replace(/^\.\//, "")}
        onClick={() => setPreviewOpen(true)}
      >
        <img className="block max-h-90 max-w-full object-contain" src={image.url} alt={name} />
      </Button>
      {previewOpen && (
        <ImagePreview name={name} url={image.url} onClose={() => setPreviewOpen(false)} />
      )}
    </>
  );
}

/** File card for a generated file: type, name, and the same open actions as the file pane. */
export function WorkspaceFileCard({
  path,
  label,
  projectId,
  fileOpen,
  notice,
}: {
  path: string;
  label: string;
  projectId: string;
  fileOpen: FileOpen;
  notice?: string;
}) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<FileOpenTargets>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const name = fileName(path);
  const type = cardTypes[extension(path)] ?? "文件";
  const run = async (operation: "open" | "reveal" | "saveAs", target?: string) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (target !== undefined) {
        await fileOpen({ operation: "setDefault", target });
        setTargets((await fileOpen({ operation: "targets" })) as FileOpenTargets);
      }
      const result = await fileOpen({ operation, projectId, path });
      if (operation === "saveAs" && "saved" in result && result.saved)
        setMessage(t("content.fileCard.saved"));
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="conversation-web-preview"
      role="group"
      aria-label={t("content.fileCard.label", { name })}
    >
      <FileReference size={24} />
      <span className="conversation-web-preview-info">
        <strong title={path.replace(/^\.\//, "")}>{name}</strong>
        <small role={message || notice ? "status" : undefined}>
          {message || notice || (label && label !== name ? label : type)}
        </small>
      </span>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open && !targets)
            void fileOpen({ operation: "targets" })
              .then((value) => setTargets(value as FileOpenTargets))
              .catch((cause) =>
                setMessage(t("content.fileCard.targetsFailed", { error: errorText(cause) })),
              );
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={busy}
              aria-label={t("content.fileCard.chooseApp", { name })}
            >
              {t("content.fileCard.openWith")}
              <ChevronDown className="size-3" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          {targets ? (
            targets.targets.map((target) => (
              <DropdownMenuItem
                key={target.id}
                disabled={busy}
                onClick={() => void run("open", target.id)}
              >
                {target.label}
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem disabled={busy} onClick={() => void run("open")}>
              {t("common.navigation.openDefault")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy} onClick={() => void run("reveal")}>
            {t("common.navigation.reveal")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onClick={() => void run("saveAs")}>
            {t("content.fileCard.saveAs")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
