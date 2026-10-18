import { FileChanges } from "./interfaceIcons.js";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.js";
import type { Data } from "./services.js";

/** Successful filesystem receipts identify navigable workspace files. A read
 * receipt can open the current file; it does not identify a write or a Diff.
 * Tool arguments alone and Shell output cannot prove a file result.
 */
export function verifiedFileReceipts(items: Data[]): Map<string, { path: string; size: number }> {
  const files = new Map<string, { path: string; size: number }>();
  for (const item of items) {
    if (item.type !== "dynamicToolCall" || !["fs_read", "fs_create", "fs_write", "fs_apply_patch", "fs_apply_patches"].includes(item.tool)
      || item.status !== "completed" || item.success !== true) continue;
    for (const part of item.contentItems ?? []) {
      if (!["inputText", "text"].includes(part.type)) continue;
      try {
        const result = JSON.parse(part.text);
        if (typeof result.path !== "string" || !result.path.startsWith("workspace://repo/")
          || !/^[a-f0-9]{64}$/.test(result.sha256) || !Number.isSafeInteger(result.size) || result.size < 0) continue;
        const path = result.path.slice("workspace://repo/".length);
        if (!path || path.split("/").some((component: string) => component === ".." || component === ".")) continue;
        files.set(path, { path, size: result.size });
      } catch { /* Unsupported tool results remain in the original activity. */ }
    }
  }
  return files;
}

/** Completed resources contain only writes; historical totals still come from
 * the read-only Core turn comparison, never from reads or workspace Git totals.
 */
export function verifiedWrittenFiles(items: Data[]): Map<string, { path: string; size: number }> {
  return verifiedFileReceipts(items.filter(item => ["fs_create", "fs_write", "fs_apply_patch", "fs_apply_patches"].includes(item.tool)));
}

export function TurnFileSummary({ turn, readTurnReview, onFile, onReview }: {
  turn: Data; readTurnReview: (turnId: string) => Promise<Data>;
  onFile: (path: string) => void; onReview: (turnId: string) => void;
}) {
  const files = verifiedWrittenFiles(turn.items ?? []);
  const identity = JSON.stringify([turn.id, turn.status, [...files.values()]]);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [turn.id]);
  const [review, setReview] = useState<{ identity: string; totals?: Map<string, { additions: number; deletions: number }>; error?: string }>();
  useEffect(() => {
    if (turn.status !== "completed" || !files.size) return;
    let active = true;
    void readTurnReview(turn.id).then(result => {
      if (result.turnId !== turn.id || !Array.isArray(result.files)) throw Error("本轮文件比较结果不完整");
      const totals = new Map<string, { additions: number; deletions: number }>();
      for (const file of result.files) {
        if (typeof file.path !== "string" || !Number.isSafeInteger(file.additions) || file.additions < 0
          || !Number.isSafeInteger(file.deletions) || file.deletions < 0) throw Error("本轮文件行数无法验证");
        totals.set(file.path, { additions: file.additions, deletions: file.deletions });
      }
      if (active) setReview({ identity, totals });
    }).catch(cause => { if (active) setReview({ identity, error: cause.message }); });
    return () => { active = false; };
  }, [identity, readTurnReview]);
  if (turn.status !== "completed" || !files.size) return null;
  const current = review?.identity === identity ? review : undefined;
  const entries = [...files.values()];
  const totals = current?.totals && entries.reduce((sum, file) => {
    const count = current.totals!.get(file.path);
    return { additions: sum.additions + (count?.additions ?? 0), deletions: sum.deletions + (count?.deletions ?? 0) };
  }, { additions: 0, deletions: 0 });
  return <div className="turn-file-summary" data-testid="turn-file-summary">
    <div className="turn-file-summary-header">
      <strong>{files.size} 个文件已更改</strong>
      {totals && <span className="turn-file-summary-totals" aria-label={`合计新增 ${totals.additions} 行，删除 ${totals.deletions} 行`}>
        <span className="added">+{totals.additions}</span><span className="deleted">-{totals.deletions}</span>
      </span>}
      <Button size="sm" variant="ghost" className="turn-file-summary-review-action" onClick={() => onReview(turn.id)}>查看变更</Button>
    </div>
    <div className="turn-file-summary-files" role="region" aria-label="本轮文件" data-expanded={expanded}>
      {(expanded ? entries : entries.slice(0, 5)).map(file => {
        // A verified comparison omits unchanged paths. Only that successful
        // result permits zero; pending or rejected reads never do.
        const totals = current?.totals ? current.totals.get(file.path) ?? { additions: 0, deletions: 0 } : undefined;
        return <Button key={file.path} variant="ghost" aria-label={`打开 ${file.path}`} onClick={() => onFile(file.path)} title={file.path}>
        <FileChanges className="turn-file-summary-icon" aria-hidden="true" />
        <span className="turn-file-summary-title">{file.path}</span>
          {totals ? <span className="turn-file-summary-stats" aria-label={`新增 ${totals.additions} 行，删除 ${totals.deletions} 行`}>
            <span className="added">+{totals.additions}</span><span className="deleted">-{totals.deletions}</span>
          </span> : <span className="turn-file-summary-meta" title={current?.error}>{file.size} B · {current?.error ? "行数不可验证" : "读取行数…"}</span>}
      </Button>; })}
    </div>
    {entries.length > 5 && <button type="button" className="turn-file-summary-disclosure" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起文件" : `展开剩余 ${entries.length - 5} 个文件`}</button>}
  </div>;
}
