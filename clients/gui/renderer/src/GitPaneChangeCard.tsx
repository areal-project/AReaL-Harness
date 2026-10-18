// Adapted from ZCode GitPaneChangeCard. Core supplies patch text and file statistics.
import { ActivityIcon } from "./ActivityIcon.js";
import { FileTree, MessageCopy as CopyIcon, MoreOptionsIcon } from "./interfaceIcons.js";
import { MessageResponse } from "./components/ai-elements/message.js";
import { DiffViewer, type DiffViewerProps } from "./components/ui/diff-viewer.js";
import { Button } from "./components/ui/button.js";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "./components/ui/context-menu.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
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
  change, isExpanded, onOpenChange, onCopyAbsolutePath, onCopyRelativePath,
  onRevealInFileTree, onOpenFile, onOpenLocation, onOpenOutside, openingFile = false,
  reviewOptions, renderPreview = true, fullFiles = true,
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
  const file = resolveFileDisplayDescriptor(change.workspaceRelativePath);
  const fileActions = [
    { label: "复制相对路径", icon: CopyIcon, run: () => onCopyRelativePath(change) },
    { label: "在默认应用中打开", icon: undefined, run: onOpenOutside ? () => onOpenOutside(change) : undefined },
    { label: "在文件管理器中显示", icon: undefined, run: onOpenLocation ? () => onOpenLocation(change) : undefined },
    { label: "在标签页中打开文件", icon: undefined, run: onOpenFile ? () => onOpenFile(change) : undefined },
    { label: isExpanded ? "折叠文件" : "展开文件", icon: undefined, run: () => onOpenChange(change, !isExpanded) },
  ];
  return (
    <div className="w-full min-w-0" data-review-path={change.workspaceRelativePath}>
      <ContextMenu>
        {/* The collapse button and file actions are siblings; action clicks
            must not toggle the file or produce nested interactive elements. */}
        <ContextMenuTrigger render={
          <div className="review-file-header sticky top-0 z-10 flex w-full items-center gap-2 bg-background supports-[backdrop-filter]:backdrop-blur-sm">
            <button type="button" aria-label={change.workspaceRelativePath} aria-expanded={isExpanded}
              className="review-file-identity min-w-0 flex-1 overflow-hidden text-left"
              title={change.workspaceRelativePath} onClick={() => onOpenChange(change, !isExpanded)}>
              <FileDisplayIcon src={file.fileIconSrc} size={16} className="shrink-0" />
              <span className="review-file-path" dir="rtl"><bdi dir="ltr">
                {file.filePath && <span className="review-file-directory">{file.filePath}</span>}
                <span className="review-file-name">{file.fileName}</span>
              </bdi></span>
            </button>
            <div className="review-file-controls ml-auto flex shrink-0 items-center gap-1">
              <div className="review-file-stats mx-1 flex shrink-0 items-center gap-1 whitespace-nowrap text-ui-base">
                <span className="text-diff-added">+{change.added}</span>
                <span className="text-diff-removed">-{change.removed}</span>
              </div>
              <div className="review-file-actions">
                <Button variant="ghost" size="icon-xs" aria-label="复制路径" title="复制路径" onClick={() => onCopyRelativePath(change)}><CopyIcon className="size-3.5" /></Button>
                <Button variant="ghost" size="icon-xs" className="review-file-disclosure" aria-label="切换文件差异对比" title={isExpanded ? "折叠文件" : "展开文件"} aria-expanded={isExpanded} onClick={() => onOpenChange(change, !isExpanded)}><ActivityIcon kind="chevron" size={14} className="size-3.5" /></Button>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="文件操作" title="文件操作"><MoreOptionsIcon className="size-4" /></Button>} />
                <DropdownMenuContent align="end" className="w-56">
                  {fileActions.map(({ label, icon: Icon, run }) => <DropdownMenuItem key={label} disabled={!run || (openingFile && (label === "在默认应用中打开" || label === "在文件管理器中显示"))} onClick={run}>{Icon && <Icon className="size-4" />}{label}</DropdownMenuItem>)}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onCopyAbsolutePath(change)}><CopyIcon className="size-4" />复制绝对路径</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onRevealInFileTree(change)}><FileTree className="size-4" />在文件树中显示</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        } />
        <ContextMenuContent className="w-56">
          {fileActions.map(({ label, icon: Icon, run }) => <ContextMenuItem key={label} disabled={!run || (openingFile && (label === "在默认应用中打开" || label === "在文件管理器中显示"))} onClick={run}>{Icon && <Icon className="size-4" />}{label}</ContextMenuItem>)}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopyAbsolutePath(change)}><CopyIcon className="size-4" />复制绝对路径</ContextMenuItem>
          <ContextMenuItem onClick={() => onRevealInFileTree(change)}><FileTree className="size-4" />在文件树中显示</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isExpanded && (
        <div className="w-full min-w-0 overflow-x-auto overflow-y-hidden bg-background">
          {renderPreview && /\.(md|markdown)$/i.test(change.workspaceRelativePath) && change.afterText !== undefined ? (
            <div className="review-markdown-preview" data-testid="review-markdown-preview">
              <MessageResponse className="review-markdown-content" streaming={false} theme={document.documentElement.classList.contains("dark") ? "dark" : "light"}>{change.afterText}</MessageResponse>
            </div>
          ) : change.binary ? (
            <p className="px-4 py-3 text-ui-base text-foreground-subtle">二进制文件改动</p>
          ) : change.patch ? (
            <DiffViewer {...(fullFiles && change.beforeText !== undefined && change.afterText !== undefined ? {
              oldFile: { name: change.workspaceRelativePath, contents: change.beforeText },
              newFile: { name: change.workspaceRelativePath, contents: change.afterText },
              // The reference keeps one context line and folds even one omitted
              // line. Expansion is backed by these verified historical texts.
              options: { ...reviewOptions?.options, parseDiffOptions: { ...reviewOptions?.options?.parseDiffOptions, context: 1 }, collapsedContextThreshold: 0 },
            } : { patch: change.patch, options: reviewOptions?.options })} disableWorkerPool
              themeType={document.documentElement.classList.contains("dark") ? "dark" : "light"}
              diffClassName="block" selectedLines={reviewOptions?.selectedLines} annotations={reviewOptions?.annotations} />
          ) : (
            <p className="px-4 py-3 text-ui-base text-foreground-subtle">没有可显示的文本差异</p>
          )}
        </div>
      )}
    </div>
  );
}
