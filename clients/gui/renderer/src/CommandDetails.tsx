import { useState } from "react";
import { CopyTextAction } from "./MessageActions.js";
import { commandResult, toolPresentation } from "./conversationPresentation.js";
import type { Data } from "./services.js";
import { ToolCallDuration } from "./ToolCallDuration.js";

function CommandText({ text, kind, placeholder }: { text: string; kind: "命令" | "输出"; placeholder?: string }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="command-text">
    {kind === "命令" ? <button type="button" className="command-input-toggle" aria-label={expanded ? "收起完整命令" : "展开完整命令"} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <pre className="command-input" aria-label="执行命令">$ {text}</pre>
    </button> : <pre className="command-output" aria-label="工具结果">{text || placeholder}</pre>}
    {text && <CopyTextAction text={text} noun={kind} className="command-copy" iconSize={14} />}
  </div>;
}

/** Input / collected output / Core outcome, with original member records one
 * disclosure deeper. This view never requests more output or executes commands.
 */
export function CommandDetails({ item }: { item: Data }) {
  const view = toolPresentation(item);
  const output = commandResult(item);
  const process = item.processResult ?? output;
  const command = item.arguments?.command ?? item.arguments?.argv?.join(" ") ?? "";
  const rawText = (item.contentItems ?? []).map((part: Data) => part.text ?? "").join("\n");
  const pages: Data[] = item.processObservations ?? [output];
  const text = pages.map(page => [page.stdout, page.stderr].filter(Boolean).join("")).filter(Boolean).join("")
    || (output.error ? JSON.stringify(output.error, null, 2) : typeof output.prefix === "string" ? output.prefix : !Object.keys(output).length ? rawText : "");
  const reads = (item.processRecords ?? []).filter((record: Data) => record.tool === "read_process").length;
  return <div className="tool-event-body command-card">
    <div className="tool-event-heading command-heading"><span>Shell</span>{reads > 0 && <span>{reads} 次输出读取</span>}<ToolCallDuration item={item} /></div>
    {item.arguments?.cwd && <div className="command-directory" title={item.arguments.cwd}>工作目录：{item.arguments.cwd}</div>}
    {command && <CommandText kind="命令" text={command} />}
    <CommandText kind="输出" text={text} placeholder={view.running ? "等待输出…" : "无文本输出"} />
    {(item.processOutputIncomplete || output.truncated) && <p className="command-output-notice" role="status">部分输出缺失或已截断</p>}
    {item.processOutputPending && <p className="command-output-notice" role="status">输出尚未收集完整</p>}
    {process.stopReason && <p className="command-output-notice">停止原因：{process.stopReason}</p>}
    <div className={view.failed ? "command-outcome tool-failed" : "command-outcome"}>{view.status}{process.exitCode != null ? ` · 退出码 ${process.exitCode}` : ""}</div>
    <details className="command-raw"><summary>原始记录</summary><pre>{JSON.stringify(item.processRecords ?? [item], null, 2)}</pre></details>
  </div>;
}
