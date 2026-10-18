import { useRef, type KeyboardEvent } from "react";
import { DisclosureChevronIcon as ChevronRight, CloseIcon as X } from "./interfaceIcons.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "./lib/fileDisplay.js";
import { WorkspaceFileTreeRowName } from "./workspace-file-tree/WorkspaceFileTreeRowName.js";
import type { FileChange } from "./GitPaneChangeCard.js";

/** The current Core review scope, not a second workspace listing or Git query. */
type ReviewNode = { path: string; name: string; children: ReviewNode[]; file?: FileChange };
export function ReviewFileTree({ files, activePath, query, onQuery, onSelect, collapsed, onToggle, busy, error }: {
  files: FileChange[];
  activePath: string | null | undefined;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (path: string) => void;
  collapsed: string[];
  onToggle: (path: string) => void;
  busy: boolean;
  error: boolean;
}) {
  const tree = useRef<HTMLDivElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const visible = files.filter(file => file.workspaceRelativePath.toLocaleLowerCase().includes(search));
  const roots: ReviewNode[] = [], folders = new Map<string, ReviewNode>();
  for (const file of visible) {
    const parts = file.workspaceRelativePath.split("/");
    let children = roots;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let folder = folders.get(path);
      if (!folder) { folder = { path, name: parts[i], children: [] }; folders.set(path, folder); children.push(folder); }
      children = folder.children;
    }
    children.push({ path: file.workspaceRelativePath, name: parts.at(-1)!, file, children: [] });
  }
  const rows: { node: ReviewNode; name: string; ancestors: string[] }[] = [];
  const flatten = (nodes: ReviewNode[], ancestors: string[]) => {
    for (const start of nodes) {
      let node = start, name = start.name;
      while (!node.file && node.children.length === 1 && !node.children[0].file) {
        node = node.children[0]; name += "/" + node.name;
      }
      rows.push({ node, name, ancestors });
      if (!node.file && !collapsed.includes(node.path)) flatten(node.children, [...ancestors, node.path]);
    }
  };
  flatten(roots, []);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = Array.from(tree.current?.querySelectorAll<HTMLButtonElement>("[role=treeitem]") ?? []);
    const index = rows.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
  };
  return <section className="review-file-tree" data-testid="review-file-tree">
    <div className="review-file-tree-filter">
      <div className="review-file-filter-field">
        {/* 与搜索入口共用公开许可图标。 */}
        <svg aria-hidden viewBox="0 0 16 16" className="review-file-filter-icon" fill="currentColor">
          <path fillRule="evenodd" clipRule="evenodd" d="M6.99658 2.47168C9.49567 2.47168 11.522 4.49798 11.522 6.99707C11.522 8.0627 11.1521 9.04119 10.5356 9.81445L13.02 12.2988C13.225 12.5038 13.225 12.836 13.02 13.041C12.815 13.246 12.4829 13.246 12.2778 13.041L9.7915 10.5547C9.02184 11.1602 8.05175 11.5225 6.99658 11.5225C4.49749 11.5225 2.47119 9.49616 2.47119 6.99707C2.47119 4.49798 4.49749 2.47168 6.99658 2.47168ZM6.99658 3.52246C5.07739 3.52246 3.52197 5.07788 3.52197 6.99707C3.52197 8.91626 5.07739 10.4717 6.99658 10.4717C8.91577 10.4717 10.4712 8.91626 10.4712 6.99707C10.4712 5.07788 8.91577 3.52246 6.99658 3.52246Z" />
        </svg>
        <Input className="review-file-filter-input" aria-label="筛选文件" placeholder="筛选文件…"
          value={query} onChange={event => onQuery(event.target.value)} />
        {query.length > 0 && <Button variant="ghost" size="icon-xs" aria-label="清除文件筛选" onClick={() => onQuery("")}>
          <X aria-hidden />
        </Button>}
      </div>
    </div>
    <div ref={tree} role="tree" aria-label="审查改动文件" aria-busy={busy} className="min-h-0 flex-1 overflow-auto">
      {busy ? <p role="status" className="px-2 py-3 text-ui-base text-foreground-subtle">正在读取…</p>
        : error ? <p className="px-2 py-3 text-ui-base text-foreground-subtle">未能加载改动文件</p>
        : rows.map(({ node, name, ancestors }) => <button key={node.path} type="button" role="treeitem"
          aria-label={node.path} aria-level={ancestors.length + 1} aria-selected={activePath === node.path}
          aria-expanded={node.file ? undefined : !collapsed.includes(node.path)}
          title={node.path} className="review-file-tree-row" style={{ paddingLeft: 3 + ancestors.length * 12.5 }}
          onClick={() => node.file ? onSelect(node.path) : onToggle(node.path)}
          onKeyDown={event => {
            if (!node.file && (event.key === "ArrowRight" && collapsed.includes(node.path) || event.key === "ArrowLeft" && !collapsed.includes(node.path))) { event.preventDefault(); onToggle(node.path); }
            else move(event);
          }}>
          {ancestors.map((path, index) => <span key={path} aria-hidden className="review-tree-guide"
            data-active-ancestor={Boolean(activePath?.startsWith(path + "/"))}
            style={{ left: 3 + 7.5 - 0.25 + index * 12.5 }} />)}
          {node.file ? <FileDisplayIcon src={resolveFileDisplayDescriptor(node.path).fileIconSrc} size={16} className="shrink-0" />
            : <ChevronRight aria-hidden className={`size-4 shrink-0 text-foreground-subtle ${collapsed.includes(node.path) ? "" : "rotate-90"}`} />}
          <WorkspaceFileTreeRowName name={name} className="review-file-tree-name min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left" slashClassName="mx-0.5 text-foreground-subtle" />
          {node.file && <span className="review-file-tree-stats"><span className="text-diff-added">+{node.file.added}</span><span className="text-diff-removed">-{node.file.removed}</span></span>}
        </button>)}
      {!busy && !error && !visible.length && <p className="px-2 py-3 text-ui-base text-foreground-subtle">{search ? "没有匹配的文件" : "没有改动"}</p>}
    </div>
  </section>;
}
