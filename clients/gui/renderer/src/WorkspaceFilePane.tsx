// ZCode PreviewPane breadcrumb/header composition + its CodeViewer.
// AReaL's optional edit mode uses the existing revision-checked workspace API.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { EditorState } from "@codemirror/state";
import { MessageCopy as Copy, FileTree, DisclosureChevronIcon as ChevronRight, FileMenuChevronIcon as ChevronDown, RefreshIcon as RefreshCw } from "./interfaceIcons.js";
import { getFiletypeFromFileName } from "@pierre/diffs";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu.js";
import { FileDisplayInline } from "./lib/fileDisplay.js";
import { CodeViewer } from "./components/ui/code-viewer.js";
import { WorkspaceMarkdownView } from "./WorkspaceMarkdownView.js";
import type { Action, PlatformServices, FileOpenTargets } from "./services.js";
import { useCodePreferences } from "./settings/preferences.js";
type Document = { text: string; original: string; revision: string; editing: boolean; markdownState?: EditorState; saveError?: string; saving?: Promise<void> };
const documents = new Map<string, Document>();
export function confirmCloseFiles(projectId: string, paths: string[]) {
  const dirty = paths.filter((path) => {
    const doc = documents.get(`${projectId}:${path}`);
    return doc && doc.text !== doc.original;
  });
  if (dirty.length && !window.confirm(`放弃以下文件的未保存修改？\n${dirty.join("\n")}`))
    return false;
  for (const path of paths) documents.delete(`${projectId}:${path}`);
  return true;
}
export function WorkspaceFilePane({
  projectId,
  root,
  path,
  action,
  onDirty,
  onLink,
  fileOpen,
  preferredFileOpenTarget,
  filesOpen,
  onToggleFiles,
  tree,
}: {
  projectId: string;
  root: string;
  path: string;
  action: Action;
  onDirty: (path: string, dirty: boolean) => void;
  onLink: (url: string) => void;
  fileOpen?: PlatformServices["fileOpen"];
  preferredFileOpenTarget?: string;
  filesOpen: boolean;
  onToggleFiles: () => void;
  tree?: ReactNode;
}) {
  const key = `${projectId}:${path}`;
  const [doc, setDoc] = useState<Document | undefined>(documents.get(key));
  const [message, setMessage] = useState(doc?.saveError ?? "");
  const [busy, setBusy] = useState(!!doc?.saving);
  const preferences = useCodePreferences();
  const [wrap, setWrap] = useState<boolean | undefined>();
  const [markdown, setMarkdown] = useState(true);
  const mounted = useRef(true);
  const opening = useRef(false);
  const [openTargets, setOpenTargets] = useState<FileOpenTargets>();
  const [openTargetsError, setOpenTargetsError] = useState("");
  useEffect(() => {
    let current = true;
    setOpenTargets(undefined); setOpenTargetsError("");
    if (fileOpen) void fileOpen({ operation: "targets" }).then(value => {
      if (current) setOpenTargets(value as FileOpenTargets);
    }).catch(cause => { if (current) setOpenTargetsError(`打开位置读取失败：${cause.message}`); });
    return () => { current = false; };
  }, [fileOpen, preferredFileOpenTarget]);
  const api = (operation: string, values: Record<string, unknown> = {}) =>
    action("workspace", { projectId, path, operation, ...values });
  const update = (value: Document) => {
    if (mounted.current && value.text !== documents.get(key)?.text && !value.saveError) setMessage("");
    documents.set(key, value);
    onDirty(path, value.text !== value.original);
    if (mounted.current) setDoc(value);
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const cached = documents.get(key);
    if (cached) onDirty(path, cached.text !== cached.original);
    // A clean cache is a display snapshot, not the current workspace version.
    // Preserve dirty drafts; obtain a fresh revision when clean files reopen.
    if (cached?.saving) {
      setBusy(true);
      void cached.saving.then(() => {
        if (cancelled) return;
        const current = documents.get(key);
        setDoc(current);
        setMessage(current?.saveError ?? "");
        setBusy(false);
      });
    } else if (!cached || cached.text === cached.original) {
      setBusy(true);
      void api("read")
        .then((value) => {
          if (cancelled) return;
          const current = documents.get(key);
          if (current && current.text !== current.original) return;
          const document = { ...value, original: value.text, editing: current?.editing ?? false,
            markdownState: current?.text === value.text ? current?.markdownState : undefined };
          documents.set(key, document);
          if (mounted.current) setDoc(document);
        })
        .catch((e) => {
          if (!cancelled && mounted.current) setMessage(e.message);
        })
        .finally(() => {
          if (!cancelled && mounted.current) setBusy(false);
        });
    }
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [key]);
  const save = async (automatic = false) => {
    const current = documents.get(key);
    if (!current || busy || current.saving || current.text === current.original || (automatic && current.saveError)) return;
    // Blur and Cmd+S may arrive before React renders the busy state. One
    // owner sends one snapshot; failed automatic writes require explicit retry.
    let settled!: () => void;
    const pending = new Promise<void>(resolve => { settled = resolve; });
    documents.set(key, { ...current, saving: pending });
    setBusy(true);
    setMessage("");
    const failed = (error: string) => {
      const latest = documents.get(key);
      if (latest?.revision === current.revision) update({ ...latest, saveError: error });
      if (mounted.current) setMessage(error);
    };
    try {
      const value = await api("save", { text: current.text, revision: current.revision });
      if (value.conflict) {
        failed(value.error);
        return;
      }
      const latest = documents.get(key);
      // Closing/discarding cannot resurrect a document. A receipt acknowledges
      // only the submitted bytes, never a newer draft or another revision.
      if (latest?.revision === current.revision) update({ ...latest, original: current.text, revision: value.revision, saveError: undefined });
      if (mounted.current) setMessage(automatic ? "" : "文件已保存");
    } catch (e) {
      failed((e as Error).message);
    } finally {
      const latest = documents.get(key);
      if (latest?.saving === pending) update({ ...latest, saving: undefined });
      settled();
      if (mounted.current) setBusy(false);
    }
  };
  const reload = async () => {
    if (doc && doc.text !== doc.original && !window.confirm("丢弃当前草稿，重新读取磁盘版本？"))
      return;
    setBusy(true);
    try {
      const value = await api("read");
      update({ ...value, original: value.text, editing: doc?.editing ?? false });
      if (mounted.current) setMessage("");
    } catch (e) {
      if (mounted.current) setMessage((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const segments = path.split("/");
  const openOutside = async (operation: 'open' | 'reveal' | 'saveAs', target?: string) => {
    if (!fileOpen || busy || opening.current) return;
    opening.current = true; setBusy(true); setMessage("");
    try {
      if (target !== undefined) {
        await fileOpen({ operation: 'setDefault', target });
        const catalog = await fileOpen({ operation: 'targets' });
        if (mounted.current) setOpenTargets(catalog as FileOpenTargets);
      }
      const result = await fileOpen({ operation, projectId, path });
      if (operation === 'saveAs' && 'saved' in result && result.saved && mounted.current) setMessage('文件已另存');
    }
    catch (cause) {
      if (mounted.current) {
        const message = (cause as Error).message;
        const detail = operation === 'saveAs' ? message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : message;
        setMessage(operation === 'saveAs' && /^[A-Z][A-Z0-9]+:/.test(detail) ? '无法另存文件，请检查来源文件与所选位置后重试' : detail);
      }
    }
    finally { opening.current = false; if (mounted.current) setBusy(false); }
  };
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(path);
  return (
    <aside
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-testid="workspace-file-preview"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="panel-toolbar file-preview-toolbar">
        <nav className="file-preview-path min-w-0 flex-1" aria-label="文件路径" title={`${root}/${path}`}>
          <div className="flex min-w-max items-center gap-0.5 text-ui-sm text-foreground-subtle">
            <span>{root.split("/").pop()}</span>
            <ChevronRight className="size-3.5 shrink-0 text-foreground-subtlest" />
            {segments.slice(0, -1).map((segment, index) => (
              <Fragment key={index}>
                <span>{segment}</span>
                <ChevronRight className="size-3.5 shrink-0 text-foreground-subtlest" />
              </Fragment>
            ))}
            <FileDisplayInline path={path} options={{ showIcon: false, className: "inline-flex shrink-0 items-center", fileNameClassName: "whitespace-nowrap text-ui-sm font-medium text-foreground" }} />
          </div>
        </nav>
        <div className="file-preview-actions flex shrink-0 items-center gap-1.5">
          {isMarkdown && !doc?.editing && <Button size="sm" variant="ghost" className="file-preview-control" disabled={!doc} onClick={() => setMarkdown(value => !value)}>{markdown ? "查看源代码" : "渲染预览"}</Button>}
          <Button size="icon-md" variant="ghost" className="file-preview-control file-preview-icon" aria-label="切换文件树" aria-pressed={filesOpen} onClick={onToggleFiles}><FileTree className="size-4" /></Button>
          {doc && (doc.editing || doc.text !== doc.original) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || doc.text === doc.original}
              onClick={() => void save()}
            >
              保存
            </Button>
          )}
          <div className="file-preview-open-group" role="group" aria-label="文件打开操作">
          <Button size="sm" variant="ghost" className="file-preview-control file-preview-open" aria-label={openTargets ? `在${openTargets.preferredLabel}中打开` : "在默认应用中打开"} title={openTargets ? `在${openTargets.preferredLabel}中打开` : "在默认应用中打开"} disabled={!fileOpen || busy} onClick={() => void openOutside('open')}>打开</Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-md" variant="ghost" className="file-preview-control file-preview-open-options" aria-label="文件更多">
                  <ChevronDown className="size-3" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-48">
              {openTargets ? openTargets.targets.map(target => <DropdownMenuItem key={target.id} disabled={busy} onClick={() => void openOutside('open', target.id)}>
                {target.label}
              </DropdownMenuItem>) : <DropdownMenuItem disabled={!fileOpen || busy} onClick={() => void openOutside('open')}>在默认应用中打开</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!fileOpen || busy} onClick={() => void openOutside('reveal')}>在文件管理器中显示</DropdownMenuItem>
              <DropdownMenuItem disabled={!fileOpen || busy} onClick={() => void openOutside('saveAs')}>另存为…</DropdownMenuItem>
              <DropdownMenuSeparator />
              {isMarkdown && (
                <DropdownMenuItem onClick={() => setMarkdown(!markdown)}>
                  {markdown ? "查看源码" : "预览 Markdown"}
                </DropdownMenuItem>
              )}
              <DropdownMenuCheckboxItem
                checked={wrap ?? preferences.wrapLongLines}
                onCheckedChange={(value) => setWrap(!!value)}
              >
                自动换行
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem
                disabled={!doc || busy}
                onClick={() => doc && update({ ...doc, editing: !doc.editing })}
              >
                {doc?.editing ? "阅读代码" : "编辑代码"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  void navigator.clipboard
                    .writeText(`${root}/${path}`)
                    .catch((e) => setMessage(e.message))
                }
              >
                <Copy className="size-4" />
                复制绝对路径
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  void navigator.clipboard.writeText(path).catch((e) => setMessage(e.message))
                }
              >
                <Copy className="size-4" />
                复制相对路径
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onClick={() => void reload()}>
                <RefreshCw className="size-4" />
                重新读取文件
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>
      </div>
      {(message || openTargetsError) && (
        <div
          role="status"
          className="px-3 py-2 text-ui-base whitespace-pre-wrap text-foreground-subtle"
        >
          {message || openTargetsError}
        </div>
      )}
      {busy && !doc && (
        <p role="status" className="p-3 text-ui-base text-foreground-subtle">
          正在读取…
        </p>
      )}
      <div className="workspace-file-layout min-h-0 min-w-0 flex flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {doc?.editing ? (
            <textarea
              className="workspace-file-editor"
              aria-label={`编辑 ${path}`}
              spellCheck={false}
              disabled={busy}
              value={doc.text}
              onChange={(e) => update({ ...doc, text: e.target.value })}
            />
          ) : doc ? (
            isMarkdown && markdown ? (
              <div className="workspace-markdown-reading">
                <WorkspaceMarkdownView text={doc.text} state={doc.markdownState} disabled={busy} onLink={onLink}
                  onChange={(text, markdownState) => {
                    const current = documents.get(key);
                    if (current) update({ ...current, text, markdownState });
                  }}
                  onBlur={() => { void save(true); }} />
                <Button size="icon-md" variant="ghost" className="workspace-markdown-copy" aria-label="复制 Markdown" onClick={() => { void navigator.clipboard.writeText(doc.text).then(() => setMessage("")).catch(error => setMessage(error.message)); }}><Copy className="size-4" /></Button>
              </div>
            ) : (
              <CodeViewer
                code={doc.text}
                language={getFiletypeFromFileName(path)}
                wrapLongLines={wrap ?? preferences.wrapLongLines}
              />
            )
          ) : null}
        </div>
        {tree && <aside className="panel-resource-tree" aria-label="文件列表">{tree}</aside>}
      </div>
    </aside>
  );
}
