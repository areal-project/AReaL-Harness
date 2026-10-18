// Toolbar, empty state and change-card layout adapted from ZCode GitPane.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { ReviewEmptyGlyph, ReviewDiffLayoutGlyph, ReviewOptionGlyph, RefreshIcon as RefreshCw, MenuSelectedIcon as Check, FileTree, MoreOptionsIcon, MenuChevronIcon as ChevronDown, NavigationForwardIcon as ArrowRight } from "./interfaceIcons.js";
import { Input } from "./components/ui/input.js";
import { GitPaneChangeCard, type FileChange } from "./GitPaneChangeCard.js";
import type { Action, PlatformServices } from "./services.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuGroup, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "./components/ui/dropdown-menu.js";
import { GitActions } from "./GitActions.js";
import { Popover, PopoverTrigger, PopoverContent } from "./components/ui/popover.js";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "./components/ui/command.js";
import type { SelectedLineRange, FileDiffOptions, DiffLineAnnotation } from "@pierre/diffs";
import type { ReactNode } from "react";
import { ReviewFileTree } from "./ReviewFileTree.js";
import { ReviewCommentView } from "./ReviewCommentViews.js";
import { setCodePreferences, useCodePreferences } from "./settings/preferences.js";
import { captureReviewComment, useReviewComments, writeReviewComments, reviewCommentKey, type ReviewComment, type ReviewCommentDraft, type ReviewVersion } from "./reviewComments.js";
// File lookup glyph from the saved Codex 26.928 readonly CDP geometry.
function JumpToFileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M10.8711 8.80615C12.3848 8.80615 13.6123 10.0336 13.6123 11.5474C13.6123 12.1172 13.4374 12.646 13.1396 13.0845L14.374 14.3179C14.579 14.5228 14.5789 14.856 14.374 15.061C14.169 15.266 13.8359 15.266 13.6309 15.061L12.3945 13.8237C11.9586 14.1161 11.4353 14.2886 10.8711 14.2886C9.35746 14.2886 8.13001 13.061 8.12988 11.5474C8.12989 10.0337 9.35738 8.80616 10.8711 8.80615ZM10.8711 9.85693C9.93728 9.85694 9.18067 10.6136 9.18066 11.5474C9.1808 12.4811 9.93736 13.2378 10.8711 13.2378C11.8048 13.2378 12.5614 12.4811 12.5615 11.5474C12.5615 10.6135 11.8049 9.85693 10.8711 9.85693Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M9.36816 1.80811C10.0378 1.80811 10.6798 2.07482 11.1533 2.54834L12.6484 4.04346C13.122 4.51699 13.3887 5.15895 13.3887 5.82861V7.16357C13.3886 7.45346 13.1532 7.68799 12.8633 7.68799C12.5734 7.68799 12.338 7.45346 12.3379 7.16357V6.85889H10.833C9.80694 6.85871 8.97479 6.02656 8.97461 5.00049V2.85889H4.86328C4.04866 2.85889 3.38867 3.51888 3.38867 4.3335V11.6665C3.38867 12.4811 4.04866 13.1421 4.86328 13.1421H6.36328C6.65312 13.1421 6.8885 13.3767 6.88867 13.6665C6.88867 13.9565 6.65323 14.1919 6.36328 14.1919H4.86328C3.46876 14.1919 2.33789 13.061 2.33789 11.6665V4.3335C2.33789 2.93898 3.46876 1.80811 4.86328 1.80811H9.36816ZM10.0254 5.00049C10.0256 5.44666 10.3868 5.80793 10.833 5.80811H12.3369C12.3316 5.42434 12.178 5.05742 11.9062 4.78564L10.4111 3.29053C10.2975 3.17693 10.1665 3.08541 10.0254 3.01514V5.00049Z" fill="currentColor" />
    </svg>
  );
}

const scopeItems = [
  ["last-turn", "上一轮"],
  ["uncommitted", "未提交的更改"],
  ["unstaged", "未暂存的更改"],
  ["staged", "已暂存的更改"],
  ["commit", "已提交的更改"],
  ["branch", "分支比较"],
  ["task", "任务工作区更改"],
].map(([value, label]) => ({ value, label }));
type TurnReviewRequest = { turnId: string; scope?: never } | { scope: "unstaged"; turnId?: never };
const views = new Map<string, { selectedTurnId?: string; request?: TurnReviewRequest; scope: string; ref: string; activePath: string | null; fileExpansion: Map<string, boolean>; expandedAll: boolean; treeQuery: string; treeCollapsed: string[]; scrollTop: number }>();
type CommitChoice = { id: string; subject: string; committedAt: number };
type BranchChoice = { ref: string; name: string; id: string };
const commitAge = (timestamp: number) => {
  const seconds = (timestamp * 1000 - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto", style: "short" }).format(Math.trunc(seconds / size), unit);
};
export function GitPane({
  projectId,
  root,
  action,
  onReveal,
  onFile,
  fileOpen,
  threadId,
  commentsDisabled = false,
  turnId,
  reviewRequest,
  filesOpen = false,
  onToggleFiles,
}: {
  projectId: string;
  root: string;
  action: Action;
  onReveal: (path: string) => void;
  onFile?: (path: string) => void;
  fileOpen?: PlatformServices["fileOpen"];
  threadId: string;
  commentsDisabled?: boolean;
  turnId?: string;
  reviewRequest?: TurnReviewRequest;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
}) {
  const workspaceContextId = useId();
  const reviewRoot = useRef<HTMLElement>(null);
  const commentKey = reviewCommentKey(projectId, threadId);
  const { draft, error: storageError } = useReviewComments(commentKey);
  const codePreferences = useCodePreferences();
  const reviewLayout = useRef<HTMLDivElement>(null);
  const treePane = useRef<HTMLElement>(null);
  const treeDrag = useRef<{ x: number; width: number } | null>(null);
  const [treeWidth, setTreeWidth] = useState(() => {
    const saved = Number(localStorage.getItem("areal-gui:review-tree-width"));
    return Number.isFinite(saved) && saved >= 200 ? saved : 250;
  });
  const [layoutWidth, setLayoutWidth] = useState<number>();
  const [diffWidth, setDiffWidth] = useState<number>();
  useLayoutEffect(() => {
    const layout = reviewLayout.current;
    const scroll = reviewScroll.current;
    if (!layout || !scroll) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === layout) setLayoutWidth(entry.contentRect.width);
        else setDiffWidth(entry.contentRect.width);
      }
    });
    observer.observe(layout);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { localStorage.setItem("areal-gui:review-tree-width", String(treeWidth)); }, [treeWidth]);
  const treeMaximum = layoutWidth === undefined ? treeWidth : Math.max(200, layoutWidth * 0.6);
  const treeActual = Math.min(treeWidth, treeMaximum);
  const resizeTree = (next: number) => {
    if (next < 100) { treeDrag.current = null; onToggleFiles?.(); return; }
    const maximum = Math.max(200, (reviewLayout.current?.getBoundingClientRect().width ?? treeMaximum / 0.6) * 0.6);
    setTreeWidth(Math.min(maximum, Math.max(200, next)));
  };
  const [renderPreview, setRenderPreview] = useState(() => localStorage.getItem("areal-gui:review-render-preview") !== "false");
  const [diffMode, setDiffMode] = useState<"auto" | "unified" | "split">(() => {
    const saved = localStorage.getItem("areal-gui:review-diff-layout");
    return saved === "unified" || saved === "split" ? saved : "auto";
  });
  const [wordDiffs, setWordDiffs] = useState(() => localStorage.getItem("areal-gui:review-word-diffs") !== "false");
  const [fullFiles, setFullFiles] = useState(() => localStorage.getItem("areal-gui:review-full-files") !== "false");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(() => localStorage.getItem("areal-gui:review-ignore-whitespace") === "true");
  const [commentError, setCommentError] = useState("");
  const [fileError, setFileError] = useState("");
  const [openingFile, setOpeningFile] = useState(false);
  const openOutside = async (file: FileChange, operation: "open" | "reveal") => {
    if (!fileOpen || openingFile) return;
    setOpeningFile(true); setFileError("");
    try { await fileOpen({ operation, projectId, path: file.workspaceRelativePath }); }
    catch (cause) { setFileError((cause as Error).message); }
    finally { setOpeningFile(false); }
  };
  const [version, setVersion] = useState<ReviewVersion>();
  const [selection, setSelection] = useState<{ path: string; range: SelectedLineRange }>();
  const disabled = commentsDisabled || !!storageError;
  const persist = (next: ReviewCommentDraft) => {
    try {
      const key = `areal-gui:draft:${projectId}:${threadId}`;
      if (disabled || localStorage.getItem(`${key}:pending`) || localStorage.getItem(`${key}:pending-create`)) throw new Error("当前输入正在提交或等待确认，请稍后添加评论。");
      writeReviewComments(commentKey, next); setCommentError(""); return true;
    }
    catch (cause) { setCommentError(`评论保存失败：${(cause as Error).message}`); return false; }
  };
  const viewKey = JSON.stringify([projectId, threadId]);
  const remembered = views.get(viewKey);
  const [selectedTurnId, setSelectedTurnId] = useState(remembered?.selectedTurnId);
  const handledRequest = useRef(remembered?.request);
  const availableScopes = selectedTurnId ? [{ value: "turn", label: "所选轮次" }, ...scopeItems] : scopeItems;
  const [treeQuery, setTreeQuery] = useState(remembered?.treeQuery ?? "");
  const [treeCollapsed, setTreeCollapsed] = useState(remembered?.treeCollapsed ?? []);
  const [scope, setScope] = useState(remembered?.scope ?? (turnId ? "last-turn" : "unstaged"));
  const [ref, setRef] = useState(remembered?.ref ?? "HEAD");
  const [applied, setApplied] = useState(ref);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [commits, setCommits] = useState<CommitChoice[]>();
  const [commitsTruncated, setCommitsTruncated] = useState(false);
  const [commitsError, setCommitsError] = useState("");
  const [manualRef, setManualRef] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [branches, setBranches] = useState<BranchChoice[]>();
  const [branchesError, setBranchesError] = useState("");
  const [reference, setReference] = useState<{ projectId: string; scope: string; ref: string; id: string; label: string; branch: string }>();
  useEffect(() => {
    if (!scopeOpen) return;
    let active = true;
    setCommits(undefined); setCommitsError(""); setCommitsTruncated(false);
    void action("workspace", { projectId, operation: "reviewCommits" }).then(result => {
      if (active) { setCommits(result.commits); setCommitsTruncated(result.truncated); }
    }).catch(cause => { if (active) setCommitsError((cause as Error).message); });
    return () => { active = false; };
  }, [scopeOpen, projectId, action]);
  useEffect(() => {
    if (!branchOpen) return;
    let active = true;
    setBranches(undefined); setBranchesError(""); setBranchQuery("");
    void action("workspace", { projectId, operation: "reviewBranches" }).then(result => {
      if (active) setBranches(result.branches);
    }).catch(cause => { if (active) setBranchesError((cause as Error).message); });
    return () => { active = false; };
  }, [branchOpen, projectId, action]);
  const [activePath, setActivePath] = useState<string | null | undefined>(remembered ? remembered.activePath : draft.editing?.path ?? draft.comments[0]?.path);
  const [fileExpansion, setFileExpansion] = useState(() => remembered?.fileExpansion ?? new Map<string, boolean>());
  // Git overviews start compact; explicit per-path choices survive range and
  // task navigation. Canonical turn reviews retain their open reading default.
  const fileExpanded = (path: string) => fileExpansion.get(path) ?? (scope === "last-turn" || scope === "turn");
  const [expandedAll, setExpandedAll] = useState(remembered?.expandedAll ?? false);
  const reviewScroll = useRef<HTMLDivElement>(null);
  const readingTop = useRef(remembered?.scrollTop ?? 0);
  const restoringTop = useRef<number | undefined>(remembered?.scrollTop);
  const resetReading = () => {
    restoringTop.current = undefined; readingTop.current = 0;
    if (reviewScroll.current) reviewScroll.current.scrollTop = 0;
  };
  // A card request is explicit navigation, including a repeated click after
  // manual scope changes. Consume it once; remount/return restores the existing
  // view instead of replaying the last request over a later manual selection.
  useLayoutEffect(() => {
    if (!reviewRequest || handledRequest.current === reviewRequest) return;
    handledRequest.current = reviewRequest;
    setSelectedTurnId(reviewRequest.turnId); setScope(reviewRequest.scope ?? "turn");
    setSelection(undefined); setTreeQuery(""); setActivePath(null);
    setFileExpansion(new Map()); setExpandedAll(false); resetReading();
  }, [reviewRequest]);
  const previousLatestTurn = useRef(turnId);
  useLayoutEffect(() => {
    // Reviewing the current round retains the existing follow-latest behavior
    // when Core completes a follow-up. Explicit older history stays selected.
    if (previousLatestTurn.current !== turnId && scope === "turn" && selectedTurnId === previousLatestTurn.current) setScope("last-turn");
    previousLatestTurn.current = turnId;
  }, [turnId, scope, selectedTurnId]);
  const reviewTurnId = scope === "turn" ? selectedTurnId : turnId;
  const reviewRef = scope === "turn" ? selectedTurnId ?? "" : applied;
  const [files, setFiles] = useState<FileChange[]>([]);
  const textFiles = files.filter(file => !file.binary && !!file.patch);
  const hasFullTexts = textFiles.some(file => file.beforeText !== undefined && file.afterText !== undefined);
  const canFilterWhitespace = fullFiles && textFiles.length > 0 && textFiles.every(file => file.beforeText !== undefined && file.afterText !== undefined);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const [notice, setNotice] = useState("");
  const shownReference = !busy && !error && reference?.projectId === projectId && reference.scope === scope && reference.ref === applied ? reference : undefined;
  // Existing keyed panel and review result own this context. Hide it during
  // reads/failures and between scopes, rather than inferring another repository.
  const shownRoot = !busy && !error && version?.scope === scope && version.ref === reviewRef ? version.root : undefined;
  useEffect(() => {
    if (activePath !== undefined) views.set(viewKey, { selectedTurnId, request: handledRequest.current, scope, ref: applied, activePath, fileExpansion, expandedAll, treeQuery, treeCollapsed, scrollTop: readingTop.current });
  }, [viewKey, selectedTurnId, reviewRequest, scope, applied, activePath, fileExpansion, expandedAll, treeQuery, treeCollapsed]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setSelection(undefined);
    setError("");
    setNotice("");
    void action("workspace", { projectId, threadId, turnId: reviewTurnId, operation: scope === "last-turn" || scope === "turn" ? "turnReview" : "review", scope, ref: reviewRef })
      .then((result) => {
        if (!active) return;
        if (scope === "turn" && result.turnId !== reviewTurnId) throw Error("比较结果不属于所选轮次");
        setVersion({ token: result.token, head: result.head, base: result.base, root: result.root, scope, ref: reviewRef });
        setReference(result.reference ? { ...result.reference, projectId, scope, ref: applied, branch: result.branch } : undefined);
        setNotice(result.notice ?? "");
        const patches = result.diff.split(/(?=^diff --git )/m).filter(Boolean);
        const nextFiles: FileChange[] = result.files.map(
            (
              file: { path: string; additions: number; deletions: number; binary: boolean; beforeText?: string; afterText?: string },
              index: number,
            ) => ({
              workspaceRelativePath: file.path,
              added: file.additions,
              removed: file.deletions,
              binary: file.binary,
              patch: patches[index] ?? "",
              beforeText: file.beforeText,
              afterText: file.afterText,
            }),
          );
        // Pair each file with its original patch before sorting presentation.
        // The Git new-file marker is authoritative; an empty prior text alone
        // does not distinguish a new file from an existing empty file.
        if (scope !== "last-turn" && scope !== "turn") nextFiles.sort((a, b) =>
          Number(/^new file mode /m.test(b.patch)) - Number(/^new file mode /m.test(a.patch))
          || a.workspaceRelativePath.localeCompare(b.workspaceRelativePath, "en", { sensitivity: "base" }));
        setFiles(nextFiles);
        setActivePath(current => current === undefined ? nextFiles[0]?.workspaceRelativePath ?? null : current);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setReference(undefined);
          setFiles([]);
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, threadId, reviewTurnId, action, scope, applied, reviewRef, revision]);
  // The existing per-task view owns reading too. Pierre paints asynchronously;
  // restore when real content has capacity, without timers or execution replay.
  useLayoutEffect(() => {
    const scroll = reviewScroll.current;
    if (busy || !scroll || restoringTop.current === undefined) return;
    const restore = () => {
      const top = restoringTop.current;
      if (top === undefined) return;
      scroll.scrollTop = top;
      if (scroll.scrollTop === top) restoringTop.current = undefined;
    };
    const observer = new ResizeObserver(restore);
    observer.observe(scroll);
    for (const child of scroll.children) observer.observe(child);
    restore();
    return () => observer.disconnect();
  }, [busy]);
  const visibleFiles = files.filter(file => file.workspaceRelativePath.toLocaleLowerCase().includes(treeQuery.trim().toLocaleLowerCase()));
  const selectedPath = visibleFiles.find(file => file.workspaceRelativePath === activePath)?.workspaceRelativePath ?? visibleFiles[0]?.workspaceRelativePath;
  const beginComment = (path: string, range: SelectedLineRange) => {
    if (disabled || busy || !version) return;
    setActivePath(path);
    // An empty, new editor may follow a Shift/drag range. Never move an existing
    // saved comment or discard text already entered for another selection.
    const extending = draft.editing && !draft.editing.body && draft.editing.path === path && draft.editing.token === version.token && !draft.comments.some(c => c.id === draft.editing?.id);
    if (draft.editing && !extending) { setCommentError("请先保存或取消正在编辑的评论。"); return; }
    try {
      const file = files.find(file => file.workspaceRelativePath === path);
      if (!file || file.binary) return;
      const historicalText = file.beforeText !== undefined && file.afterText !== undefined
        ? (range.side === "deletions" ? file.beforeText : file.afterText) : undefined;
      const editing = captureReviewComment(path, file.patch, range, version, historicalText);
      persist({ ...draft, editing: extending ? { ...editing, id: draft.editing!.id } : editing });
    } catch (cause) { setCommentError((cause as Error).message); }
  };
  const renderComment = (comment: ReviewComment) => {
    const editing = draft.editing?.id === comment.id;
    const existing = draft.comments.some(c => c.id === comment.id);
    return <ReviewCommentView key={comment.id} comment={editing ? draft.editing! : comment} editing={editing} existing={existing} stale={comment.token !== version?.token} attached={!!draft.attachedIds?.includes(comment.id)} disabled={disabled}
      onEdit={() => { if (draft.editing) setCommentError("请先保存或取消正在编辑的评论。"); else persist({ ...draft, editing: comment }); }}
      onChange={body => { if (draft.editing?.id === comment.id) persist({ ...draft, editing: { ...draft.editing, body } }); }}
      onSave={() => {
        if (draft.editing?.id !== comment.id || !draft.editing.body.trim()) return;
        const saved = { ...draft.editing, body: draft.editing.body.trim() };
        const comments = existing ? draft.comments.map(c => c.id === saved.id ? saved : c) : [...draft.comments, saved];
        if (persist({ ...draft, comments, editing: undefined, attachedIds: [...new Set([...(draft.attachedIds ?? []), saved.id])] })) setSelection(undefined);
      }}
      onCancel={() => { if (draft.editing?.id === comment.id && persist({ ...draft, editing: undefined })) setSelection(undefined); }}
      onRemove={() => { if (persist({ ...draft, comments: draft.comments.filter(c => c.id !== comment.id), editing: draft.editing?.id === comment.id ? undefined : draft.editing, attachedIds: draft.attachedIds?.filter(id => id !== comment.id) })) setSelection(undefined); }}
      onAdd={() => persist({ ...draft, attachedIds: [...new Set([...(draft.attachedIds ?? []), comment.id])] })} />;
  };
  const newEditing = draft.editing && !draft.comments.some(c => c.id === draft.editing!.id) ? draft.editing : undefined;
  const previewing = (file: FileChange) => renderPreview && /\.(md|markdown)$/i.test(file.workspaceRelativePath) && file.afterText !== undefined;
  const anchored = (comment: ReviewComment) => !busy && !error && comment.token === version?.token && fileExpanded(comment.path) && visibleFiles.some(f => f.workspaceRelativePath === comment.path && !f.binary && !previewing(f));
  const annotations = new Map<string, DiffLineAnnotation<ReactNode>[]>();
  const byFile = new Map<string, Map<string, { side: ReviewComment["side"]; lineNumber: number; nodes: ReactNode[] }>>();
  for (const comment of [...draft.comments, ...(newEditing ? [newEditing] : [])]) if (anchored(comment)) {
    const lines = byFile.get(comment.path) ?? new Map();
    const key = `${comment.side}:${comment.end}`, entry = lines.get(key) ?? { side: comment.side, lineNumber: comment.end, nodes: [] };
    entry.nodes.push(renderComment(comment)); lines.set(key, entry); byFile.set(comment.path, lines);
  }
  for (const [path, lines] of byFile) annotations.set(path, Array.from(lines.values(), entry => ({
    side: entry.side, lineNumber: entry.lineNumber, metadata: <div className="grid min-w-0 gap-2 p-1.5">{entry.nodes}</div>,
  })));
  const selectionOptions = useMemo<FileDiffOptions<ReactNode, undefined>>(() => ({
    unsafeCSS: `[data-utility-button] { background-color: var(--color-foreground); color: var(--color-background); border: none; border-radius: 4px; margin-right: 0; }
      [data-utility-button]:hover { background-color: color-mix(in srgb, var(--color-foreground) 88%, var(--color-background)); }
      [data-separator="line-info"] [data-expand-button] {
        border-inline-end: 1px solid var(--diffs-bg);
        border-start-start-radius: 8px;
        border-end-start-radius: 8px;
      }
      [data-separator="line-info"] [data-separator-wrapper][data-separator-multi-button] [data-expand-up] { border-end-start-radius: 0; }
      [data-separator="line-info"] [data-separator-wrapper][data-separator-multi-button] [data-expand-down] { border-start-start-radius: 0; }
      [data-unified] [data-separator="line-info"] [data-separator-content] { border-start-end-radius: 8px; border-end-end-radius: 8px; }
      [data-unified] [data-separator="line-info"] [data-separator-wrapper] {
        grid-template-columns: var(--diffs-column-number-width) minmax(0, 1fr);
        padding-inline: var(--diffs-gap-inline, var(--diffs-gap-fallback));
      }
      [data-selected-line][data-line-annotation] { background-color: var(--diffs-bg); }
      /* Buffer derives from the code theme; selected annotations use the UI surface above. */
      [data-line-annotation]:not([data-selected-line]) {
        background-color: light-dark(color-mix(in lab, var(--diffs-light-bg, #fff) 92%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-dark-bg, #000) 92%, var(--diffs-mixer)));
      }
      [data-line-type="change-addition"]:is([data-line], [data-no-newline]) {
        --diffs-computed-diff-line-bg: light-dark(color-mix(in lab, var(--diffs-light-bg, #fff) 88%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-dark-bg, #000) 80%, var(--diffs-addition-base)));
      }
      [data-line-type="change-deletion"]:is([data-line], [data-no-newline]) {
        --diffs-computed-diff-line-bg: light-dark(color-mix(in lab, var(--diffs-light-bg, #fff) 88%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-dark-bg, #000) 80%, var(--diffs-deletion-base)));
      }
      [data-line-type="change-addition"]:is([data-column-number], [data-gutter-buffer]) {
        --diffs-computed-diff-line-bg: light-dark(color-mix(in lab, #fff 91%, var(--diffs-addition-base)), color-mix(in lab, #000 85%, var(--diffs-addition-base)));
      }
      [data-line-type="change-deletion"]:is([data-column-number], [data-gutter-buffer]) {
        --diffs-computed-diff-line-bg: light-dark(color-mix(in lab, #fff 91%, var(--diffs-deletion-base)), color-mix(in lab, #000 85%, var(--diffs-deletion-base)));
      }
      [data-line-type="change-addition"][data-hovered]:not([data-selected-line]) {
        --diffs-computed-hovered-line-bg: light-dark(color-mix(in lab, var(--diffs-light-bg, #fff) 80%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-dark-bg, #000) 70%, var(--diffs-addition-base)));
      }
      [data-line-type="change-deletion"][data-hovered]:not([data-selected-line]) {
        --diffs-computed-hovered-line-bg: light-dark(color-mix(in lab, var(--diffs-light-bg, #fff) 80%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-dark-bg, #000) 75%, var(--diffs-deletion-base)));
      }`,
    enableLineSelection: !disabled, enableGutterUtility: !disabled, lineHoverHighlight: "both",
  }), [disabled]);
  const optionsByPath = useMemo(() => new Map(files.map(file => {
    const path = file.workspaceRelativePath;
    return [path, {
      ...selectionOptions,
      // Auto uses the code viewport, including an independently resized tree.
      // Pure creation/deletion stays unified, as in the observed reference.
      diffStyle: diffMode === "auto" ? (diffWidth !== undefined && diffWidth >= 800 && file.added > 0 && file.removed > 0 ? "split" : "unified") : diffMode,
      lineDiffType: wordDiffs ? "word-alt" : "none",
      // Presentation only: retain the original file texts, line identities,
      // Core totals and version-bound comments when comparing trimmed lines.
      parseDiffOptions: { ignoreWhitespace: canFilterWhitespace && ignoreWhitespace },
      onLineSelected: range => { if (range) setActivePath(path); setSelection(range ? { path, range } : undefined); },
      onLineSelectionEnd: range => { if (range) beginComment(path, range); },
      // Gutter clicks already commit Pierre's drag/Shift range.
      onLineClick: line => { setActivePath(path); if (!line.numberColumn) setSelection({ path, range: { side: line.annotationSide, start: line.lineNumber, end: line.lineNumber } }); },
      onGutterUtilityClick: range => beginComment(path, range),
    } satisfies FileDiffOptions<ReactNode, undefined>];
  })), [selectionOptions, files, disabled, busy, version, draft, diffMode, diffWidth, wordDiffs, canFilterWhitespace, ignoreWhitespace]);
  const copy = (path: string) =>
    void navigator.clipboard.writeText(path).catch((e) => setError(e.message));
  const setPreview = (value: boolean) => {
    setSelection(undefined); setRenderPreview(value);
    localStorage.setItem("areal-gui:review-render-preview", String(value));
  };
  return (
    <section ref={reviewRoot} className="workspace-review flex h-full min-h-0 flex-col bg-background" data-testid="workspace-review" data-review-source={scope === "last-turn" || scope === "turn" ? "history" : "git"}>
      <div className="panel-toolbar review-toolbar">
        <div className="review-toolbar-source" role="group" aria-label="审查来源" aria-describedby={shownRoot ? workspaceContextId : undefined} title={shownRoot}>
        {shownRoot && <span id={workspaceContextId} className={shownRoot === root ? "sr-only" : "review-workspace-context"} aria-label="审查工作区" title={shownRoot}>{shownRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? shownRoot}</span>}
        <DropdownMenu open={scopeOpen} onOpenChange={setScopeOpen}>
          <DropdownMenuTrigger render={<Button variant="ghost" aria-label="改动范围" title={scope === "turn" ? selectedTurnId : scope === "commit" ? applied : undefined} className="review-scope-trigger min-w-0 max-w-full" />}>
            <span className="truncate">{scope === "turn" && selectedTurnId === turnId ? "上一轮" : availableScopes.find(item => item.value === scope)?.label}</span><ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-[200px]">
            {availableScopes.map(({ value, label }) => <DropdownMenuGroup key={value}>
              {["uncommitted", "commit", "task"].includes(value) && <DropdownMenuSeparator />}
              {value === "commit" ? <DropdownMenuSub>
                <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-w-[min(520px,var(--available-width))]">
                  {commitsError ? <DropdownMenuLabel role="alert" className="max-w-72 whitespace-normal font-normal">{commitsError}</DropdownMenuLabel>
                    : commits === undefined ? <DropdownMenuLabel role="status">正在读取提交…</DropdownMenuLabel>
                    : !commits.length ? <DropdownMenuLabel>当前分支没有提交</DropdownMenuLabel>
                    : commits.map(commit => <DropdownMenuItem key={commit.id} title={commit.id} onClick={() => {
                        setRef(commit.id); setApplied(commit.id); setManualRef(false); setScope("commit");
                      }}>
                        <span className="min-w-0 truncate">{commit.subject || commit.id.slice(0, 7)}</span>
                        <span className="shrink-0 text-ui-sm text-foreground-subtle">{commitAge(commit.committedAt)}</span>
                        {scope === "commit" && applied === commit.id && <Check className="ml-auto size-4" />}
                      </DropdownMenuItem>)}
                  {commitsTruncated && <DropdownMenuLabel>仅显示最近100个提交</DropdownMenuLabel>}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => { setManualRef(true); setScope("commit"); }}>输入提交…</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub> : <DropdownMenuItem onClick={() => { setManualRef(false); setScope(value); }}>
                {label}{scope === value && <Check className="ml-auto size-4" />}
              </DropdownMenuItem>}
            </DropdownMenuGroup>)}
          </DropdownMenuContent>
        </DropdownMenu>
        {scope === "commit" && shownReference && <span className="review-reference-context" data-testid="review-reference-context" title={shownReference.id}>{shownReference.label}</span>}
        {!busy && !error && !!files.length && <span className="review-totals" aria-label="改动行数">
          <span className="text-success">+{files.reduce((total, file) => total + file.added, 0)}</span>
          <span className="text-destructive">-{files.reduce((total, file) => total + file.removed, 0)}</span>
        </span>}
        </div>
        <div className="review-toolbar-actions" role="group" aria-label="审查操作">
        <GitActions key={projectId} projectId={projectId} action={action} onChanged={() => { setBusy(true); refresh(n => n + 1); }} indexReview={scope === "unstaged" || scope === "staged" ? { scope, revision, enabled: !!shownRoot && files.length > 0, token: version?.token, target: reviewRoot.current } : undefined} renderTrigger={openGit => <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="变更选项" />}><MoreOptionsIcon className="size-4" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => refresh(n => n + 1)}><RefreshCw className="size-4" />刷新改动</DropdownMenuItem>
            <DropdownMenuItem onClick={openGit}>Git 操作</DropdownMenuItem>
            <DropdownMenuItem disabled={disabled || busy || !selection} onClick={() => { if (selection) beginComment(selection.path, selection.range); }}>评论所选行</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={codePreferences.wrapLongLines} onCheckedChange={value => setCodePreferences({ wrapLongLines: value })}><ReviewOptionGlyph kind="wrap" />自动换行</DropdownMenuCheckboxItem>
            <DropdownMenuItem onClick={() => {
              const next = diffMode === "auto" ? "unified" : diffMode === "unified" ? "split" : "auto";
              localStorage.setItem("areal-gui:review-diff-layout", next); setDiffMode(next);
            }}><ReviewDiffLayoutGlyph mode={diffMode} className="size-4" />{diffMode === "auto" ? "自动布局：切换到统一 Diff" : diffMode === "unified" ? "切换到并排 Diff" : "切换到自动布局"}</DropdownMenuItem>
            <DropdownMenuItem disabled={busy || !!error || !files.length} onClick={() => {
              setSelection(undefined); setFileExpansion(old => {
                const next = new Map(old);
                for (const file of files) next.set(file.workspaceRelativePath, !expandedAll);
                return next;
              }); setExpandedAll(!expandedAll);
            }}>{expandedAll && <ReviewOptionGlyph kind="collapse" />}{expandedAll ? "折叠所有 Diff" : "展开所有 Diff"}</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={fullFiles} disabled={busy || !!error || !hasFullTexts} onCheckedChange={value => {
              setSelection(undefined); localStorage.setItem("areal-gui:review-full-files", String(value)); setFullFiles(value);
            }}><ReviewOptionGlyph kind="full-files" />加载完整文件</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={renderPreview} onCheckedChange={setPreview}><ReviewOptionGlyph kind="preview" />渲染预览</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={wordDiffs} onCheckedChange={value => {
              localStorage.setItem("areal-gui:review-word-diffs", String(value)); setWordDiffs(value);
            }}><ReviewOptionGlyph kind="word-diffs" />词级差异</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={ignoreWhitespace} disabled={busy || !!error || !canFilterWhitespace} onCheckedChange={value => {
              setSelection(undefined); localStorage.setItem("areal-gui:review-ignore-whitespace", String(value)); setIgnoreWhitespace(value);
            }}><ReviewOptionGlyph kind="whitespace" />隐藏行首尾空白差异</DropdownMenuCheckboxItem>
            {notice && <><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuLabel className="max-w-72 whitespace-normal font-normal text-foreground-subtle">{notice}</DropdownMenuLabel></DropdownMenuGroup></>}
          </DropdownMenuContent>
        </DropdownMenu>} />
        <Button variant="ghost" size="icon" aria-label="跳转到文件" disabled={!onFile || !selectedPath} onClick={() => { if (selectedPath) onFile?.(selectedPath); }}><JumpToFileIcon /></Button>
        {onToggleFiles && <Button variant="ghost" size="icon" aria-label={filesOpen ? "隐藏文件" : "显示文件"} aria-pressed={filesOpen} onClick={onToggleFiles}><FileTree className="size-4" /></Button>}
        </div>
      </div>
      {scope === "branch" && <div className="review-branch-row" role="group" aria-label="分支比较版本">
        <div className="review-toolbar-source">
          <span className="review-current-branch" data-testid="review-current-branch" title={shownReference?.branch}>{shownReference?.branch ?? (busy ? "正在读取…" : "")}</span>
          <ArrowRight className="size-3 shrink-0 text-foreground-subtle" />
          <Popover open={branchOpen} onOpenChange={setBranchOpen}>
            <PopoverTrigger render={<Button variant="ghost" aria-label="比较基准" className="review-scope-trigger min-w-0" title={shownReference?.id ?? applied} />}>
              <span className="truncate">{shownReference?.label ?? applied}</span><ChevronDown />
            </PopoverTrigger>
            <PopoverContent aria-label="选择比较分支" variant="menu" align="end" className="w-72 gap-0">
              <Command className="bg-transparent p-0 text-foreground">
                <CommandInput aria-label="搜索分支" placeholder="搜索分支" value={branchQuery} onValueChange={setBranchQuery} />
                <CommandList className="max-h-80">
                  {branchesError ? <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">{branchesError}</p>
                    : branches === undefined ? <p role="status" className="px-3 py-2 text-ui-sm text-foreground-subtle">正在读取分支…</p>
                    : <>
                      {!branches.length ? <p className="px-3 py-2 text-ui-sm text-foreground-subtle">当前仓库没有分支</p> : <CommandEmpty>没有匹配的分支</CommandEmpty>}
                      <CommandGroup heading="分支">
                      {branches.map(branch => <CommandItem key={branch.ref} value={branch.ref} keywords={[branch.name]} data-checked={applied === branch.ref || shownReference?.label === branch.name} onSelect={() => {
                        setRef(branch.ref); setApplied(branch.ref); setManualRef(false); setBranchOpen(false);
                      }}>
                        <span className="truncate">{branch.name}</span>
                      </CommandItem>)}
                      </CommandGroup>
                    </>}
                  {(branches !== undefined || branchesError) && <CommandGroup className="border-t border-border"><CommandItem value="manual-reference" onSelect={() => { setManualRef(true); setBranchOpen(false); }}>输入引用…</CommandItem></CommandGroup>}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>}
      {(["branch", "commit"].includes(scope) && manualRef) && (
        <form
          className="flex shrink-0 gap-2 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ref.trim()) setApplied(ref.trim());
          }}
        >
          <Input value={ref} onChange={(e) => setRef(e.target.value)} aria-label="参考分支或提交" />
          <Button variant="outline" disabled={!ref.trim()} type="submit">
            应用
          </Button>
        </form>
      )}
      {(storageError || commentError) && <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">{storageError || commentError}</p>}
      {fileError && <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">{fileError}</p>}
      <div ref={reviewLayout} className="panel-resource-layout review-resource-layout" data-file-preview>
      <div ref={reviewScroll} className="review-change-scroll min-h-0 min-w-0 flex-1 overflow-auto"
        onWheel={() => { restoringTop.current = undefined; }} onTouchStart={() => { restoringTop.current = undefined; }}
        onKeyDown={() => { restoringTop.current = undefined; }}
        onScroll={event => {
          if (restoringTop.current !== undefined) return;
          readingTop.current = event.currentTarget.scrollTop;
          const view = views.get(viewKey); if (view) view.scrollTop = readingTop.current;
        }}>
        {error ? (
          <p role="alert" className="p-3 text-ui-base text-destructive whitespace-pre-wrap">
            {error}
          </p>
        ) : busy ? (
          <p role="status" className="p-3 text-ui-base text-foreground-subtle">
            正在读取…
          </p>
        ) : files.length ? (
          !visibleFiles.length ? <p className="p-3 text-ui-base text-foreground-subtle">没有匹配的文件</p> : visibleFiles.map((change) => (
            <GitPaneChangeCard
              key={change.workspaceRelativePath}
              change={change}
              renderPreview={renderPreview}
              fullFiles={fullFiles}
              reviewOptions={{ options: optionsByPath.get(change.workspaceRelativePath),
                selectedLines: draft.editing && anchored(draft.editing) && draft.editing.path === change.workspaceRelativePath
                  ? { side: draft.editing.side, start: draft.editing.start, end: draft.editing.end }
                  : selection?.path === change.workspaceRelativePath ? { ...selection.range, side: selection.range.side ?? "additions" } : null,
                annotations: annotations.get(change.workspaceRelativePath) }}
              isExpanded={fileExpanded(change.workspaceRelativePath)}
              onOpenChange={(file, open) => {
                setSelection(undefined); setActivePath(file.workspaceRelativePath);
                if (!open) setExpandedAll(false);
                setFileExpansion(old => new Map(old).set(file.workspaceRelativePath, open));
              }}
              onCopyAbsolutePath={(file) => copy(`${root}/${file.workspaceRelativePath}`)}
              onCopyRelativePath={(file) => copy(file.workspaceRelativePath)}
              onRevealInFileTree={(file) => { resetReading(); setTreeQuery(""); setTreeCollapsed([]); onReveal(file.workspaceRelativePath); }}
              onOpenFile={onFile ? (file) => onFile(file.workspaceRelativePath) : undefined}
              onOpenLocation={fileOpen ? (file) => void openOutside(file, "reveal") : undefined}
              onOpenOutside={fileOpen ? (file) => void openOutside(file, "open") : undefined}
              openingFile={openingFile}
            />
          ))
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-foreground-subtle">
            {scope === "staged" ? <>
              <p className="text-ui-base font-medium text-foreground">没有已暂存的更改</p>
              <p className="text-ui-base">暂存文件后可在这里审查</p>
              <Button variant="secondary" size="sm" onClick={() => { setManualRef(false); setScope("branch"); resetReading(); }}>查看分支差异</Button>
            </> : <>
              <ReviewEmptyGlyph className="review-empty-illustration" />
              <div className="review-empty-copy">
                <p className="review-empty-heading">暂无文件改动</p>
                <p className="review-empty-description">此项目中的改动将显示在这里。</p>
              </div>
            </>}
          </div>
        )}
        <div className="grid gap-2 px-3 pb-3">
          {newEditing && !anchored(newEditing) && renderComment(newEditing)}
          {draft.comments.filter(c => !anchored(c)).map(renderComment)}
        </div>
      </div>
      {filesOpen && <aside ref={treePane} className="panel-resource-tree review-tree-pane" aria-label="文件列表" style={{ width: treeActual }}>
        <div className="side-pane-resize review-tree-resize" role="separator" aria-label="调整审查文件列表宽度"
          aria-orientation="vertical" aria-valuemin={Math.min(200, (layoutWidth ?? Infinity) * 0.6)}
          aria-valuemax={layoutWidth === undefined ? treeMaximum : layoutWidth * 0.6}
          aria-valuenow={Math.min(treeActual, (layoutWidth ?? Infinity) * 0.6)} tabIndex={0}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
            treeDrag.current = { x: event.clientX, width: treePane.current!.getBoundingClientRect().width };
          }}
          onPointerMove={event => { if (treeDrag.current) resizeTree(treeDrag.current.width + treeDrag.current.x - event.clientX); }}
          onPointerUp={event => {
            treeDrag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { treeDrag.current = null; }}
          onLostPointerCapture={() => { treeDrag.current = null; }}
          onKeyDown={event => {
            const actual = treePane.current!.getBoundingClientRect().width;
            const next = ({ ArrowLeft: actual + 10, ArrowRight: actual - 10, Home: 200, End: treeMaximum } as Record<string, number>)[event.key];
            if (next !== undefined) { event.preventDefault(); event.stopPropagation(); resizeTree(next); }
          }} />
        <ReviewFileTree files={files} activePath={selectedPath} query={treeQuery} onQuery={query => { resetReading(); setSelection(undefined); setTreeQuery(query); }}
          collapsed={treeCollapsed} onToggle={path => setTreeCollapsed(old => old.includes(path) ? old.filter(p => p !== path) : [...old, path])}
          onSelect={path => {
            if (path !== activePath) setSelection(undefined);
            resetReading(); setActivePath(path); setTreeQuery(path);
            setFileExpansion(old => new Map(old).set(path, true));
          }} busy={busy} error={!!error} />
      </aside>}
      </div>
    </section>
  );
}
