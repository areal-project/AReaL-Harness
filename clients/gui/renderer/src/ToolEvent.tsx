// Adapted from ZCode ToolSummaryRow / ToolLayout; Codex reference guides presentation.
// Core owns all outcomes.
import { useEffect, useId, useState } from "react";
import { AgentAvatar, agentName, spawnedAgent } from "./AgentIdentity.js";
import { ActivityIcon } from "./ActivityIcon.js";
import { toolPresentation } from "./conversationPresentation.js";
import { CommandDetails } from "./CommandDetails.js";
import { ToolCallDuration } from "./ToolCallDuration.js";
import { Button } from "./components/ui/button.js";
import { verifiedFileReceipts } from "./TurnFileSummary.js";
import { DiffViewer } from "./components/ui/diff-viewer.js";
import { MessageActions } from "./MessageActions.js";
import type { Data } from "./services.js";
export function ToolEvent({ item, onFile, onAgent, turnId, readTurnReview, animate = false, onDisclosureChange }: {
  animate?: boolean; onDisclosureChange?: (open: boolean) => void;
  item: Data; onAgent?: (id: string) => void; onFile?: (path: string) => void; turnId?: string;
  readTurnReview?: (turnId: string, itemId?: string) => Promise<Data>;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => { const next = !open; setOpen(next); onDisclosureChange?.(next); };
  const [diffOpen, setDiffOpen] = useState(false);
  const [review, setReview] = useState<{ itemId: string; diff?: string; file?: { path: string; additions: number; deletions: number; beforeText: string; afterText: string }; error?: string }>();
  const recordId = useId();
  const diffId = useId();
  const view = toolPresentation(item);
  const childId = onAgent && spawnedAgent(item);
  const isCommand = ["run_command", "verify_command", "read_process", "terminate_process"].includes(item.tool);
  const file = onFile && !view.failed && !view.running ? verifiedFileReceipts([item]).values().next().value : undefined;
  const readOnly = item.tool === "fs_read";
  useEffect(() => {
    setReview(undefined); setDiffOpen(false);
    if (!file || readOnly || !turnId || !readTurnReview) return;
    let active = true;
    void readTurnReview(turnId, item.id).then(result => {
      if (result.turnId !== turnId || result.itemId !== item.id || result.scope !== "tool"
        || typeof result.diff !== "string" || !Array.isArray(result.files) || result.files.length > 1) throw Error("本次文件比较结果不完整");
      const change = result.files[0];
      if (change && (change.path !== file.path || typeof change.beforeText !== "string" || typeof change.afterText !== "string"
        || !Number.isSafeInteger(change.additions) || change.additions < 0 || !Number.isSafeInteger(change.deletions) || change.deletions < 0)) throw Error("本次文件版本或行数无法验证");
      if (active) setReview({ itemId: item.id, diff: result.diff, file: change });
    }).catch(cause => { if (active) setReview({ itemId: item.id, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; };
  }, [turnId, item.id, file?.path, readOnly, readTurnReview]);
  const current = review?.itemId === item.id ? review : undefined;
  return (
    <div className="tool-event" data-tool-id={item.id} data-tool-status={view.status}>
      {childId ? <div className="agent-spawn-row">
        <button type="button" className="agent-spawn-link" aria-label={`打开 ${childId} 子对话`} title={agentName(childId)} onClick={() => onAgent?.(childId)}><AgentAvatar id={childId} size={14} /><span>已创建 1 个智能体</span></button>
        <button type="button" className="agent-spawn-record" aria-label="查看工具原始记录" aria-expanded={open} aria-controls={recordId} onClick={toggle}><ActivityIcon kind="chevron" size={14} className={open ? "tool-chevron open" : "tool-chevron"} /></button>
      </div> : file ? <div className="tool-summary-row tool-file-row">
        <ActivityIcon kind={readOnly ? "read" : "edit"} />
        <span>{readOnly ? "已读取" : item.tool === "fs_create" ? "已创建" : "已编辑"}</span>
        <Button variant="ghost" className="tool-file-link" aria-label={`打开 ${file.path}`} title={file.path} onClick={() => onFile?.(file.path)}>{file.path.split("/").at(-1)}</Button>
        {current && !current.error && <Button variant="ghost" className="tool-file-diff-toggle" aria-label="查看本次文件更改" aria-expanded={diffOpen} aria-controls={diffId} onClick={() => setDiffOpen(!diffOpen)}>
          <span className="tool-file-stats" aria-label={`本次新增 ${current.file?.additions ?? 0} 行，删除 ${current.file?.deletions ?? 0} 行`}>+{current.file?.additions ?? 0} -{current.file?.deletions ?? 0}</span>
          <ActivityIcon kind="chevron" size={14} className={diffOpen ? "tool-chevron open" : "tool-chevron"} />
        </Button>}
        {current?.error && <span className="tool-result" title={current.error}>本次改动无法验证</span>}
        <Button variant="ghost" className="tool-file-record" aria-label="查看工具原始记录" title="查看工具原始记录" aria-expanded={open} aria-controls={recordId} onClick={toggle}>
          <ActivityIcon kind="chevron" size={14} className={open ? "tool-chevron open" : "tool-chevron"} />
        </Button>
      </div> : <button
        className="tool-summary-row"
        aria-expanded={open}
        onClick={toggle}
        title={item.tool}
      >
        <ActivityIcon kind={view.kind} />
        <span className={animate && view.running ? "tool-summary-text turn-thinking" : "tool-summary-text"} role={view.running ? "status" : undefined}>
          <span>{view.running ? "正在" : view.status === "已完成" ? "已" : ""}{view.label}</span>
          <span className="tool-summary-detail">{view.detail}</span>
        </span>
        <span className={view.failed ? "tool-result tool-failed" : view.status === "已完成" || view.running ? "sr-only" : "tool-result"}>
          {view.status}
        </span>
        <ActivityIcon kind="chevron" size={14} className={open ? "tool-chevron open" : "tool-chevron"} />
      </button>}
      {file && diffOpen && current && !current.error && <div className="tool-file-diff" id={diffId} role="region" aria-label="本次文件更改">
        <div className="tool-file-diff-header">
          <Button variant="ghost" className="tool-file-link" aria-label={`打开 ${file.path}`} title={file.path} onClick={() => onFile?.(file.path)}>{file.path.split("/").at(-1)}</Button>
          <span className="text-diff-added">+{current.file?.additions ?? 0}</span><span className="text-diff-removed">-{current.file?.deletions ?? 0}</span>
          <MessageActions text={current.diff ?? ""} noun="差异" />
        </div>
        {current.file ? <DiffViewer oldFile={{ name: file.path, contents: current.file.beforeText }} newFile={{ name: file.path, contents: current.file.afterText }}
          disableWorkerPool themeType={document.documentElement.classList.contains("dark") ? "dark" : "light"}
          options={{ enableLineSelection: false, enableGutterUtility: false, parseDiffOptions: { context: 1 }, collapsedContextThreshold: 0 }} />
          : <p className="p-3 text-ui-sm text-foreground-subtle">本次写入没有文本差异</p>}
      </div>}
      {open && (isCommand ? <CommandDetails item={item} /> :
        <div className="tool-event-body" id={recordId} role={file ? "region" : undefined} aria-label={file ? "工具原始记录" : undefined}>
          <div className="tool-event-heading tool-record-heading"><span>{item.tool}</span><ToolCallDuration item={item} /></div>
            <pre aria-label="工具参数">{JSON.stringify(item.arguments, null, 2)}</pre>
            <pre aria-label="工具结果">{(item.contentItems ?? []).map((c: Data) => c.text ?? "").join("\n") || (view.running ? "等待工具输出…" : "无文本输出")}</pre>
            {item.execution?.exitCode != null && <small>退出码 {item.execution.exitCode}</small>}
        </div>
      )}
    </div>
  );
}
