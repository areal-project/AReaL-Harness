import type { SelectedLineRange } from "@pierre/diffs";
import { useEffect, useState } from "react";

export type ReviewComment = {
  id: string; path: string; root: string; scope: string; ref: string;
  token: string; head: string; base: string;
  side: "additions" | "deletions"; start: number; end: number;
  snippet: string; body: string;
};
export type ReviewCommentDraft = { comments: ReviewComment[]; editing?: ReviewComment; attachedIds?: string[]; submission?: { requestId: string; comments: ReviewComment[] } };
export type ReviewVersion = Pick<ReviewComment, "root" | "scope" | "ref" | "token" | "head" | "base">;
export const reviewCommentKey = (projectId: string, threadId: string) => `areal-gui:review-comments:${projectId}:${threadId}`;
const validComment = (value: unknown): value is ReviewComment => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["id", "path", "root", "scope", "ref", "token", "head", "base", "snippet", "body"].every(k => typeof v[k] === "string") &&
    (v.side === "additions" || v.side === "deletions") && Number.isSafeInteger(v.start) && Number.isSafeInteger(v.end) && Number(v.start) > 0 && Number(v.end) >= Number(v.start);
};
export function readReviewComments(key: string): ReviewCommentDraft {
  const value = JSON.parse(localStorage.getItem(key) ?? '{"comments":[]}');
  if (!value || !Array.isArray(value.comments) || !value.comments.every(validComment) || (value.editing && !validComment(value.editing)) ||
    (value.attachedIds !== undefined && (!Array.isArray(value.attachedIds) || !value.attachedIds.every((id: unknown) => typeof id === "string" && value.comments.some((c: ReviewComment) => c.id === id)))) ||
    (value.submission !== undefined && (typeof value.submission?.requestId !== "string" || !Array.isArray(value.submission.comments) || !value.submission.comments.every(validComment)))) throw new Error("评论草稿无法读取，原记录已保留。");
  return value;
}
export function writeReviewComments(key: string, draft: ReviewCommentDraft) {
  localStorage.setItem(key, JSON.stringify(draft));
  window.dispatchEvent(new CustomEvent("areal-review-comments-change", { detail: key }));
}
export function useReviewComments(key: string) {
  const read = () => {
    try { return { draft: readReviewComments(key), error: "" }; }
    catch (cause) { return { draft: { comments: [] } as ReviewCommentDraft, error: (cause as Error).message }; }
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    setState(read());
    const refresh = (event: Event) => { if ((event as CustomEvent<string>).detail === key) setState(read()); };
    window.addEventListener("areal-review-comments-change", refresh);
    return () => window.removeEventListener("areal-review-comments-change", refresh);
  }, [key]);
  return state;
}
export const attachedReviewComments = (draft: ReviewCommentDraft) => draft.comments.filter(c => draft.attachedIds?.includes(c.id));
// This is only unsent UI state. Accepted feedback remains in Core's ordinary
// text history; a local comment is never promoted to a server-side review record.
export function detachReviewComments(key: string) {
  const draft = readReviewComments(key);
  if (draft.attachedIds?.length) writeReviewComments(key, { ...draft, attachedIds: [] });
}
export function consumeReviewComments(key: string, submitted: ReviewComment[]) {
  if (!submitted.length) return;
  const draft = readReviewComments(key);
  const matches = (comment: ReviewComment) => submitted.some(original => original.id === comment.id && reviewCommentText(original) === reviewCommentText(comment));
  const comments = draft.comments.filter(comment => !matches(comment));
  writeReviewComments(key, { ...draft, comments,
    editing: draft.editing && matches(draft.editing) ? undefined : draft.editing,
    attachedIds: draft.attachedIds?.filter(id => comments.some(comment => comment.id === id)), submission: undefined });
}
export function recordUnknownReviewSubmission(key: string, requestId: string, comments: ReviewComment[]) {
  writeReviewComments(key, { ...readReviewComments(key), submission: { requestId, comments } });
}
export function reconcileReviewSubmission(key: string, requestId: string, accepted: boolean) {
  const draft = readReviewComments(key);
  if (draft.submission?.requestId !== requestId) return;
  if (accepted) consumeReviewComments(key, draft.submission.comments);
  else writeReviewComments(key, { ...draft, submission: undefined });
}
export function transferNewReviewComments(projectId: string, threadId: string) {
  const sourceKey = reviewCommentKey(projectId, "new"), targetKey = reviewCommentKey(projectId, threadId);
  if (!localStorage.getItem(sourceKey)) return;
  const source = readReviewComments(sourceKey), target = readReviewComments(targetKey);
  if (target.editing && source.editing && target.editing.id !== source.editing.id) throw new Error("目标任务已有评论草稿，原评论已保留。");
  const comments = new Map(target.comments.map(comment => [comment.id, comment]));
  for (const comment of source.comments) if (!comments.has(comment.id)) comments.set(comment.id, comment);
  writeReviewComments(targetKey, { comments: [...comments.values()], editing: target.editing ?? source.editing,
    attachedIds: [...new Set([...(target.attachedIds ?? []), ...(source.attachedIds ?? [])])] });
  localStorage.removeItem(sourceKey);
  window.dispatchEvent(new CustomEvent("areal-review-comments-change", { detail: sourceKey }));
}
export function captureReviewComment(path: string, patch: string, range: SelectedLineRange, version: ReviewVersion, historicalText?: string): ReviewComment {
  const side = range.side ?? "additions";
  if (range.endSide && range.endSide !== side) throw new Error("请在同一版本中选择评论行。");
  const start = Math.min(range.start, range.end), end = Math.max(range.start, range.end);
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end - start > 999) throw new Error("请选择 1–1000 行代码。");
  let oldLine = 0, newLine = 0, inHunk = false;
  const selected: string[] = [];
  // Full-file expansion may expose lines outside the display patch. Capture
  // only the verified selected historical side, never the current disk file.
  if (historicalText !== undefined) {
    const lines = historicalText.split("\n");
    if (historicalText.endsWith("\n") || !historicalText) lines.pop();
    selected.push(...lines.slice(start - 1, end));
  } else for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk || ![" ", "+", "-"].includes(line[0])) continue;
    const belongs = side === "additions" ? line[0] !== "-" : line[0] !== "+";
    const number = side === "additions" ? newLine : oldLine;
    if (belongs && number >= start && number <= end) selected.push(line.slice(1));
    if (line[0] !== "+") oldLine++;
    if (line[0] !== "-") newLine++;
  }
  if (selected.length !== end - start + 1) throw new Error("所选范围包含未显示的代码，请在当前差异中重新选择。");
  return { ...version, id: crypto.randomUUID(), path, side, start, end, snippet: selected.join("\n"), body: "" };
}
export const reviewCommentLabel = (c: ReviewComment) => `${c.path} ${c.side === "additions" ? "新版" : "旧版"}第 ${c.start}${c.end === c.start ? "" : `–${c.end}`} 行`;
export function reviewCommentText(comment: ReviewComment) {
  // The captured code/version travels with feedback; a later file edit cannot
  // reinterpret these line numbers as a claim about the current working tree.
  const scopes: Record<string, string> = { turn: "指定轮次文件工具修改", "last-turn": "上一轮文件工具修改", unstaged: "未暂存的更改", staged: "已暂存的更改", task: "任务工作区更改", branch: "分支比较", commit: "指定提交" };
  const versionKind = ["last-turn", "turn"].includes(comment.scope) ? "版本" : "提交";
  return `审查反馈：${comment.body}\n\n位置：${comment.root}/${comment.path}\n${reviewCommentLabel(comment)}\n原始代码：\n${comment.snippet}\n\n比较范围：${scopes[comment.scope] ?? comment.scope}${["branch", "commit", "turn"].includes(comment.scope) ? `（${comment.ref}）` : ""}\n基准${versionKind}：${comment.base}\n当前${versionKind}：${comment.head}\n审查版本：${comment.token}\n以上代码来自采集时的版本，请核对当前文件再修改。`;
}

/** Rebuild a display from the exact feedback Core saved, never from local drafts.
 * This is a text projection, not a first-class Core review record. Any ambiguous
 * or incomplete block stays visible verbatim; copying always uses original text.
 */
export function sentReviewFeedback(text: string): { text: string; comments: ReviewComment[] } {
  const ending = "以上代码来自采集时的版本，请核对当前文件再修改。";
  const pattern = /^审查反馈：([\s\S]*?)\n\n位置：([^\n]+)\n(.+) (新版|旧版)第 (\d+)(?:–(\d+))? 行\n原始代码：\n([\s\S]*?)\n\n比较范围：([^\n]+)\n基准(?:提交|版本)：([^\n]*)\n当前(?:提交|版本)：([^\n]*)\n审查版本：([^\n]+)\n以上代码来自采集时的版本，请核对当前文件再修改。$/;
  const scopes: Record<string, string> = { "指定轮次文件工具修改": "turn", "上一轮文件工具修改": "last-turn", "未暂存的更改": "unstaged", "已暂存的更改": "staged", "任务工作区更改": "task", "分支比较": "branch", "指定提交": "commit" };
  const start = text.startsWith("审查反馈：") ? 0 : text.indexOf("\n\n审查反馈：");
  if (start < 0) return { text, comments: [] };
  const offset = start === 0 ? 0 : start + 2;
  const blocks = text.slice(offset).split(`${ending}\n\n`);
  const comments: ReviewComment[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = index === blocks.length - 1 ? blocks[index] : blocks[index] + ending;
    const match = pattern.exec(block);
    if (!match) return { text, comments: [] };
    const [, body, location, path, side, first, last, snippet, comparison, base, head, token] = match;
    if (!location.endsWith(`/${path}`)) return { text, comments: [] };
    const scopeName = comparison.replace(/（.*）$/, "");
    const scope = scopes[scopeName];
    if (!scope) return { text, comments: [] };
    const comment: ReviewComment = { id: `sent:${index}`, body, path, root: location.slice(0, -path.length - 1),
      side: side === "新版" ? "additions" : "deletions", start: Number(first), end: Number(last ?? first),
      snippet, scope, ref: comparison.slice(scopeName.length + 1, -1), base, head, token };
    if (!validComment(comment) || reviewCommentText(comment) !== block) return { text, comments: [] };
    comments.push(comment);
  }
  return { text: text.slice(0, start), comments };
}
