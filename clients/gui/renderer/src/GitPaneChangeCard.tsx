// Adapted from ZCode GitPaneChangeCard. Core supplies patch text and file statistics.
import { useMemo } from "react";
import { ActivityIcon } from "./ActivityIcon.js";
import { FileTree, MessageCopy as CopyIcon, MoreOptionsIcon } from "./interfaceIcons.js";
import { MessageResponse } from "./components/ai-elements/message.js";
import { DiffViewer, type DiffViewerProps } from "./components/ui/diff-viewer.js";
import { Button } from "./components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "./lib/fileDisplay.js";
export interface FileChange {
  workspaceRelativePath: string;
  added: number;
  removed: number;
  binary?: boolean;
  patch: string;
  beforeText?: string;
  afterText?: string;
}
export function GitPaneChangeCard({
  change,
  isExpanded,
  onOpenChange,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onRevealInFileTree,
  onOpenFile,
  onOpenLocation,
  onOpenOutside,
  openingFile = false,
  reviewOptions,
  renderPreview = true,
  fullFiles = true,
}: {
  change: FileChange;
  isExpanded: boolean;
  onOpenChange: (file: FileChange, open: boolean) => void;
  onCopyAbsolutePath: (file: FileChange) => void;
  onCopyRelativePath: (file: FileChange) => void;
  onRevealInFileTree: (file: FileChange) => void;
  onOpenFile?: (file: FileChange) => void;
  onOpenLocation?: (file: FileChange) => void;
  onOpenOutside?: (file: FileChange) => void;
  openingFile?: boolean;
  renderPreview?: boolean;
  fullFiles?: boolean;
  reviewOptions?: Pick<DiffViewerProps, "options" | "annotations" | "selectedLines">;
}) {
  const { workspaceRelativePath, beforeText, afterText } = change;
  const fullFileInput = useMemo(
    () =>
      fullFiles && beforeText !== undefined && afterText !== undefined
        ? {
            oldFile: { name: workspaceRelativePath, contents: beforeText },
            newFile: { name: workspaceRelativePath, contents: afterText },
          }
        : undefined,
    [fullFiles, workspaceRelativePath, beforeText, afterText],
  );
  const { ignoreWhitespace, stripTrailingCr, callback, headerOptions } =
    reviewOptions?.options?.parseDiffOptions ?? {};
  const parseDiffOptions = useMemo(
    () => ({
      ignoreWhitespace,
      stripTrailingCr,
      callback,
      headerOptions,
      context: 1,
    }),
    [ignoreWhitespace, stripTrailingCr, callback, headerOptions],
  );
  const fullFileOptions = useMemo(
    () => ({
      ...reviewOptions?.options,
      parseDiffOptions,
      collapsedContextThreshold: 0,
    }),
    [reviewOptions?.options, parseDiffOptions],
  );
  const file = resolveFileDisplayDescriptor(change.workspaceRelativePath);
  const fileActions = [
    { label: "复制相对路径", icon: CopyIcon, run: () => onCopyRelativePath(change) },
    {
      label: "在默认应用中打开",
      icon: undefined,
      run: onOpenOutside ? () => onOpenOutside(change) : undefined,
    },
    {
      label: "在文件管理器中显示",
      icon: undefined,
      run: onOpenLocation ? () => onOpenLocation(change) : undefined,
    },
    {
      label: "在标签页中打开文件",
      icon: undefined,
      run: onOpenFile ? () => onOpenFile(change) : undefined,
    },
    {
      label: isExpanded ? "折叠文件" : "展开文件",
      icon: undefined,
      run: () => onOpenChange(change, !isExpanded),
    },
  ];
  return (
    <div className="w-full min-w-0" data-review-path={change.workspaceRelativePath}>
      <ContextMenu>
        {/* The collapse button and file actions are siblings; action clicks
            must not toggle the file or produce nested interactive elements. */}
        <ContextMenuTrigger
          render={
            <div className="review-file-header sticky top-0 z-10 flex w-full items-center gap-2 bg-background supports-[backdrop-filter]:backdrop-blur-sm">
              <Button
                unstyled
                data-slot={undefined}
                type="button"
                aria-label={change.workspaceRelativePath}
                aria-expanded={isExpanded}
                className="review-file-identity min-w-0 flex-1 overflow-hidden text-left"
                title={change.workspaceRelativePath}
                onClick={() => onOpenChange(change, !isExpanded)}
              >
                <FileDisplayIcon src={file.fileIconSrc} size={16} className="shrink-0" />
                <span className="review-file-path" dir="rtl">
                  <bdi dir="ltr">
                    {file.filePath && (
                      <span className="review-file-directory">{file.filePath}</span>
                    )}
                    <span className="review-file-name">{file.fileName}</span>
                  </bdi>
                </span>
              </Button>
              <div className="review-file-controls ml-auto flex shrink-0 items-center gap-1">
                <div className="review-file-stats mx-1 flex shrink-0 items-center gap-1 whitespace-nowrap text-ui-base">
                  <span className="text-diff-added">+{change.added}</span>
                  <span className="text-diff-removed">-{change.removed}</span>
                </div>
                <div className="review-file-actions">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="复制路径"
                    title="复制路径"
                    onClick={() => onCopyRelativePath(change)}
                  >
                    <CopyIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="review-file-disclosure"
                    aria-label="切换文件差异对比"
                    title={isExpanded ? "折叠文件" : "展开文件"}
                    aria-expanded={isExpanded}
                    onClick={() => onOpenChange(change, !isExpanded)}
                  >
                    <ActivityIcon kind="chevron" size={14} className="size-3.5" />
                  </Button>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon-xs" aria-label="文件操作" title="文件操作">
                        <MoreOptionsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-56">
                    {fileActions.map(({ label, icon: Icon, run }) => (
                      <DropdownMenuItem
                        key={label}
                        disabled={
                          !run ||
                          (openingFile &&
                            (label === "在默认应用中打开" || label === "在文件管理器中显示"))
                        }
                        onClick={run}
                      >
                        {Icon && <Icon className="size-4" />}
                        {label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onCopyAbsolutePath(change)}>
                      <CopyIcon className="size-4" />
                      复制绝对路径
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onRevealInFileTree(change)}>
                      <FileTree className="size-4" />
                      在文件树中显示
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          }
        />
        <ContextMenuContent className="w-56">
          {fileActions.map(({ label, icon: Icon, run }) => (
            <ContextMenuItem
              key={label}
              disabled={
                !run ||
                (openingFile && (label === "在默认应用中打开" || label === "在文件管理器中显示"))
              }
              onClick={run}
            >
              {Icon && <Icon className="size-4" />}
              {label}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopyAbsolutePath(change)}>
            <CopyIcon className="size-4" />
            复制绝对路径
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onRevealInFileTree(change)}>
            <FileTree className="size-4" />
            在文件树中显示
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isExpanded && (
        <div className="w-full min-w-0 overflow-x-auto overflow-y-hidden bg-background">
          {renderPreview &&
          /\.(md|markdown)$/i.test(change.workspaceRelativePath) &&
          change.afterText !== undefined ? (
            <div className="review-markdown-preview" data-testid="review-markdown-preview">
              <MessageResponse
                className="review-markdown-content"
                streaming={false}
                theme={document.documentElement.classList.contains("dark") ? "dark" : "light"}
              >
                {change.afterText}
              </MessageResponse>
            </div>
          ) : change.binary ? (
            <p className="px-4 py-3 text-ui-base text-foreground-subtle">二进制文件改动</p>
          ) : change.patch ? (
            <DiffViewer
              {...(fullFileInput
                ? {
                    ...fullFileInput,
                    options: fullFileOptions,
                  }
                : { patch: change.patch, options: reviewOptions?.options })}
              disableWorkerPool
              themeType={document.documentElement.classList.contains("dark") ? "dark" : "light"}
              diffClassName="block"
              selectedLines={reviewOptions?.selectedLines}
              annotations={reviewOptions?.annotations}
            />
          ) : (
            <p className="px-4 py-3 text-ui-base text-foreground-subtle">没有可显示的文本差异</p>
          )}
        </div>
      )}
    </div>
  );
}

export function JumpToFileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.8711 8.80615C12.3848 8.80615 13.6123 10.0336 13.6123 11.5474C13.6123 12.1172 13.4374 12.646 13.1396 13.0845L14.374 14.3179C14.579 14.5228 14.5789 14.856 14.374 15.061C14.169 15.266 13.8359 15.266 13.6309 15.061L12.3945 13.8237C11.9586 14.1161 11.4353 14.2886 10.8711 14.2886C9.35746 14.2886 8.13001 13.061 8.12988 11.5474C8.12989 10.0337 9.35738 8.80616 10.8711 8.80615ZM10.8711 9.85693C9.93728 9.85694 9.18067 10.6136 9.18066 11.5474C9.1808 12.4811 9.93736 13.2378 10.8711 13.2378C11.8048 13.2378 12.5614 12.4811 12.5615 11.5474C12.5615 10.6135 11.8049 9.85693 10.8711 9.85693Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.36816 1.80811C10.0378 1.80811 10.6798 2.07482 11.1533 2.54834L12.6484 4.04346C13.122 4.51699 13.3887 5.15895 13.3887 5.82861V7.16357C13.3886 7.45346 13.1532 7.68799 12.8633 7.68799C12.5734 7.68799 12.338 7.45346 12.3379 7.16357V6.85889H10.833C9.80694 6.85871 8.97479 6.02656 8.97461 5.00049V2.85889H4.86328C4.04866 2.85889 3.38867 3.51888 3.38867 4.3335V11.6665C3.38867 12.4811 4.04866 13.1421 4.86328 13.1421H6.36328C6.65312 13.1421 6.8885 13.3767 6.88867 13.6665C6.88867 13.9565 6.65323 14.1919 6.36328 14.1919H4.86328C3.46876 14.1919 2.33789 13.061 2.33789 11.6665V4.3335C2.33789 2.93898 3.46876 1.80811 4.86328 1.80811H9.36816ZM10.0254 5.00049C10.0256 5.44666 10.3868 5.80793 10.833 5.80811H12.3369C12.3316 5.42434 12.178 5.05742 11.9062 4.78564L10.4111 3.29053C10.2975 3.17693 10.1665 3.08541 10.0254 3.01514V5.00049Z"
        fill="currentColor"
      />
    </svg>
  );
}
