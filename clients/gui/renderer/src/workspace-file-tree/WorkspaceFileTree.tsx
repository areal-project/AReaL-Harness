// ZCode WorkspaceFileTree header and row composition, adapted to Core's workspace service.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SearchIcon as Search, CloseIcon as X, RefreshIcon as RefreshCw, MoreOptionsIcon as Ellipsis, MessageCopy as Copy } from "../interfaceIcons.js";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu.js";
import { WorkspaceFileIconDefinitions } from "./WorkspaceFileIcon.js";
import { WorkspaceFileTreeRowView, type FileRow } from "./WorkspaceFileTreeRowView.js";
import type { Action } from "../services.js";
type Entry = { name: string; dir: boolean };
type Listing = { entries: Entry[]; truncated: boolean };
const views = new Map<string, { expanded: string[]; query: string; selected: string; changedOnly: boolean }>();
export function WorkspaceFileTree({
  projectId,
  root,
  action,
  onClose,
  onOpen,
  activePath,
}: {
  projectId: string;
  root: string;
  action: Action;
  onClose: () => void;
  onOpen: (path: string) => void;
  activePath: string;
}) {
  const remembered = views.get(projectId);
  const [expanded, setExpanded] = useState(new Set(remembered?.expanded ?? []));
  const [query, setQuery] = useState(remembered?.query ?? "");
  const [selected, setSelected] = useState(activePath || remembered?.selected || "");
  const [directories, setDirectories] = useState<Record<string, Listing>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [gitAvailable, setGitAvailable] = useState(false);
  const [changedOnly, setChangedOnly] = useState(remembered?.changedOnly ?? false);
  const [matches, setMatches] = useState<FileRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => {
    views.set(projectId, { expanded: [...expanded], query, selected, changedOnly });
  }, [projectId, expanded, query, selected, changedOnly]);
  useEffect(() => {
    if (!activePath) return;
    setSelected(activePath);
    setExpanded((old) => {
      const next = new Set(old);
      const parts = activePath.split("/");
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [activePath]);
  const paths = JSON.stringify(["", ...expanded].sort());
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError("");
    void Promise.all(
      (JSON.parse(paths) as string[]).map(
        async (path) =>
          [path, await action("workspace", { projectId, operation: "list", showAll: true, path })] as const,
      ),
    )
      .then((entries) => {
        if (alive) setDirectories(Object.fromEntries(entries));
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, action, paths, revision]);
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      setTruncated(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setBusy(true);
      void action("workspace", { projectId, operation: "search", query: query.trim() })
        .then((result) => {
          if (alive) {
            setMatches(
              result.entries.map((item: { path: string; dir: boolean }) => ({
                ...item,
                name: item.path,
                depth: 0,
              })),
            );
            setTruncated(result.truncated);
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        })
        .finally(() => {
          if (alive) setBusy(false);
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId, action, query, revision]);
  useEffect(() => {
    let active = true;
    void action("workspace", { projectId, operation: "status" })
      .then((result) => {
        if (active) {
          setGitAvailable(result.available);
          setStatuses(
            Object.fromEntries(
              result.entries.map((entry: { path: string; status: string }) => [
                entry.path,
                entry.status,
              ]),
            ),
          );
        }
      })
      .catch(() => {
        if (active) setGitAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, action, revision]);
  const rows: FileRow[] = [];
  const flatten = (path: string, depth: number) => {
    for (const item of directories[path]?.entries ?? []) {
      const child = path ? `${path}/${item.name}` : item.name;
      rows.push({ ...item, path: child, depth, expanded: expanded.has(child) });
      if (item.dir && expanded.has(child)) flatten(child, depth + 1);
    }
  };
  flatten("", 0);
  const filtered = changedOnly
    ? Object.entries(statuses)
        .filter(
          ([path]) =>
            !query.trim() || path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        )
        .map(([path, status]) => ({ path, name: path, dir: false, depth: 0, status }))
    : query.trim()
      ? matches
      : rows;
  const visible = filtered.map((row) => ({
    ...row,
    status:
      statuses[row.path] ??
      (row.dir
        ? Object.entries(statuses).find(([path]) => path.startsWith(row.path + "/"))?.[1]
        : undefined),
  }));
  const toggle = useCallback(
    (path: string) => {
      setSelected(path);
      if (query.trim()) setQuery("");
      setExpanded((old) => {
        const next = new Set(old);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [query],
  );
  const open = (path: string) => {
    setSelected(path);
    if (statuses[path] !== "D") onOpen(path);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, row: FileRow) => {
    if (event.key === "Enter") {
      event.preventDefault();
      row.dir ? toggle(row.path) : open(row.path);
    }
    if (event.key === "ArrowRight" && row.dir && !row.expanded) {
      event.preventDefault();
      toggle(row.path);
    }
    if (event.key === "ArrowLeft" && row.dir && row.expanded) {
      event.preventDefault();
      toggle(row.path);
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nodes = Array.from(
        tree.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [],
      );
      const current = nodes.indexOf(event.currentTarget);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? nodes.length - 1
            : Math.max(
                0,
                Math.min(nodes.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
              );
      nodes[index]?.focus();
    }
  };
  return (
    <section
      className="flex h-full min-h-0 flex-col text-foreground"
      data-testid="workspace-file-tree"
      data-changed-only={changedOnly}
    >
      <WorkspaceFileIconDefinitions />
      <div className="workspace-tree-search-row">
        <div className="review-file-filter-field">
          <Search className="review-file-filter-icon" />
          <input
            className="review-file-filter-input"
            placeholder={changedOnly ? "搜索更改…" : "搜索文件…"}
            aria-label="搜索文件"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && <Button variant="ghost" size="icon-xs" aria-label="清除搜索" onClick={() => setQuery("")}><X className="size-3" /></Button>}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="文件树更多" title={root}><Ellipsis className="size-3.5" /></Button>} />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(root).catch((e) => setError(e.message))}><Copy className="size-4" />复制路径</DropdownMenuItem>
              {gitAvailable && <DropdownMenuItem onClick={() => setChangedOnly(!changedOnly)}>{changedOnly ? "显示全部文件" : "仅显示更改"}</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => refresh((n) => n + 1)}><RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />刷新文件</DropdownMenuItem>
              <DropdownMenuItem onClick={onClose}><X className="size-4" />关闭文件列表</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div
        ref={tree}
        role="tree"
        aria-label="工作区文件"
        aria-busy={busy}
        className="workspace-tree-rows min-h-0 flex-1 overflow-auto px-1 pb-2"
      >
        {error && (
          <p role="alert" className="px-2 py-3 text-ui-base text-destructive">
            {error}
          </p>
        )}
        {visible.map((row) => (
          <WorkspaceFileTreeRowView
            key={row.path}
            row={row}
            root={root}
            selected={selected === row.path}
            onOpen={open}
            onToggle={toggle}
            onKeyDown={keyDown}
            onError={setError}
          />
        ))}
        {!visible.length && !busy && !error && (
          <p className="px-2 py-3 text-ui-base text-foreground-subtle">
            {query ? "没有匹配的文件" : "此文件夹为空"}
          </p>
        )}
        {(truncated || Object.values(directories).some((d) => d.truncated)) && (
          <p role="status" className="px-2 py-3 text-ui-base text-foreground-subtle">
            结果较多，已显示部分项目。请缩小搜索范围。
          </p>
        )}
      </div>
    </section>
  );
}
