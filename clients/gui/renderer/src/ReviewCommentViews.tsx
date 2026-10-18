import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./components/ui/popover.js";
import { ReviewCommentGlyph, CloseIcon as X, MoreOptionsIcon as Ellipsis } from "./interfaceIcons.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./components/ui/dropdown-menu.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./components/ui/dialog.js";
import { useLayoutEffect, useRef, useState } from "react";
import { reviewCommentLabel, reviewCommentText, type ReviewComment } from "./reviewComments.js";

const localLineLabel = (c: ReviewComment) => `第 ${c.side === "additions" ? "R" : "L"}${c.start}${c.start === c.end ? "" : `–${c.end}`} 行的本地评论`;
function ReviewCommentHeading({ comment }: { comment: ReviewComment }) {
  return <div className="review-comment-heading"><span className="review-comment-author"><span className="review-comment-avatar" aria-hidden="true">你</span><span>你</span></span><span>{localLineLabel(comment)}</span></div>;
}
// One keyed view keeps the input/caret alive when a saved comment starts editing.
// Text and mutations remain owned by GitPane's persisted review draft.
export function ReviewCommentView({ comment, editing, existing, stale, attached, disabled, onEdit, onChange, onSave, onCancel, onRemove, onAdd }: {
  comment: ReviewComment; editing: boolean; existing: boolean; stale: boolean; attached: boolean; disabled: boolean;
  onEdit: () => void; onChange: (body: string) => void; onSave: () => void; onCancel: () => void; onRemove: () => void; onAdd: () => void;
}) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (editing && !disabled && input.current && document.activeElement !== input.current) input.current.focus();
  }, [editing, disabled]);
  return <form role={editing ? undefined : "article"} aria-label={editing ? "编辑审查评论" : reviewCommentLabel(comment)} className={editing ? "review-comment-editor" : "review-comment-card"}
    onSubmit={event => { event.preventDefault(); if (editing) onSave(); }}
    onPointerDown={event => {
      if (!disabled && event.currentTarget.contains(event.target as Node) && !(event.target as Element).closest("textarea,button,input,select,a,[role='button']")) {
        event.preventDefault(); input.current?.focus();
      }
    }}>
    <ReviewCommentHeading comment={comment} />
    <div className="review-comment-body">
      {stale && <p role="status" className="text-foreground-subtle">原版本评论</p>}
      <Textarea ref={input} aria-label={editing ? "审查评论" : "编辑已保存审查评论"} placeholder="添加评论…" maxLength={4000} value={comment.body} readOnly={disabled || !editing}
        onFocus={() => { if (!editing && !disabled) onEdit(); }} onChange={event => { if (editing) onChange(event.target.value); }} />
    </div>
    <div className="review-comment-actions">
      {existing && editing && <Button size="sm" variant="ghost" type="button" className="review-comment-delete-editing" aria-label="移除评论" disabled={disabled} onClick={onRemove}>删除</Button>}
      {editing ? <><Button size="sm" variant="ghost" type="button" aria-label="取消评论" disabled={disabled} onClick={onCancel}>取消</Button><Button size="sm" type="submit" aria-label="保存评论" disabled={disabled || !comment.body.trim()}>{existing ? "保存" : "评论"}</Button></> : <>
      {!attached && <Button size="sm" variant="ghost" type="button" aria-label="加入输入框" disabled={disabled} onClick={onAdd}>附加评论</Button>}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" type="button" className="review-comment-menu" aria-label="评论操作"><Ellipsis className="size-4" /></Button>} />
        <DropdownMenuContent align="end">
          <DropdownMenuItem aria-label="加入输入框" disabled={disabled} onClick={onAdd}>{attached ? "已附加" : "附加评论"}</DropdownMenuItem>
          <DropdownMenuItem aria-label="编辑评论" disabled={disabled} onClick={onEdit}>编辑评论</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setSourceOpen(true)}>查看原始代码</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="ghost" type="button" aria-label="移除评论" disabled={disabled} onClick={onRemove}>删除</Button>
      </>}
    </div>
    <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
      <DialogContent><DialogTitle>原始代码</DialogTitle><DialogDescription>{reviewCommentLabel(comment)}</DialogDescription><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-ui-sm">{comment.snippet}</pre></DialogContent>
    </Dialog>
  </form>;
}

export function ReviewCommentAttachment({ comments, disabled, onRemove }: {
  comments: ReviewComment[]; disabled: boolean; onRemove: () => void;
}) {
  const [error, setError] = useState("");
  if (!comments.length) return null;
  return <div className="review-comment-attachment" data-testid="review-comment-attachment">
    <div className="review-comment-chip">
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="sm" className="review-comment-attachment-trigger" />}><ReviewCommentGlyph /><span>{comments.length} 个评论</span></PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-96">
          <PopoverTitle>审查评论</PopoverTitle>
          {comments.map(comment => <section key={comment.id} className="grid gap-2 border-t border-border py-2">
            <p className="text-ui-sm text-foreground-subtle">{reviewCommentLabel(comment)}</p>
            <p className="whitespace-pre-wrap break-words">{comment.body}</p>
            <details><summary>查看原始代码</summary><pre className="overflow-auto whitespace-pre-wrap text-ui-sm">{comment.snippet}</pre></details>
          </section>)}
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="icon-xs" aria-label="移除评论附件" disabled={disabled} onClick={() => {
        try { onRemove(); setError(""); } catch (cause) { setError((cause as Error).message); }
      }}><X /></Button>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function SentReviewComments({ comments }: { comments: ReviewComment[] }) {
  if (!comments.length) return null;
  return <div className="sent-review-comments review-comment-chip" data-testid="sent-review-comments">
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={`已发送的 ${comments.length} 个评论`} />}>
        <ReviewCommentGlyph /><span>{comments.length} 个评论</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-96 max-h-96 overflow-auto">
        <PopoverTitle>已发送的审查评论</PopoverTitle>
        {comments.map(comment => <section key={comment.id} className="grid gap-2 border-t border-border py-2">
          <p className="text-ui-sm text-foreground-subtle">{reviewCommentLabel(comment)}</p>
          <p className="whitespace-pre-wrap break-words">{comment.body}</p>
          <details><summary>完整反馈与原始代码</summary><pre className="overflow-auto whitespace-pre-wrap text-ui-sm">{reviewCommentText(comment)}</pre></details>
        </section>)}
      </PopoverContent>
    </Popover>
  </div>;
}
