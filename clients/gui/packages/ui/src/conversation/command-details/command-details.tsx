import { useState, type ReactNode } from "react";
function CommandText({ text, kind, placeholder, copy }: { text: string; kind: "命令" | "输出"; placeholder?: string; copy?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="command-text">
    {kind === "命令" ? <button type="button" className="command-input-toggle" aria-label={expanded ? "收起完整命令" : "展开完整命令"} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <pre className="command-input" aria-label="执行命令">$ {text}</pre>
    </button> : <pre className="command-output" aria-label="工具结果">{text || placeholder}</pre>}
    {copy}
  </div>;
}


export function CommandDetails({ heading, status, failed, directory, command, output, placeholder, commandCopy, outputCopy, metadata, notices, raw }: {
 heading: string; status: string; failed?: boolean; directory?: string; command?: string; output: string; placeholder: string; commandCopy?: ReactNode; outputCopy?: ReactNode; metadata?: ReactNode; notices?: ReactNode; raw: ReactNode;
}) {
 return <div className="tool-event-body command-card"><div className="tool-event-heading command-heading"><span>{heading}</span><span role="status" className={failed ? "command-outcome tool-failed" : "command-outcome"}>{status}</span>{metadata}</div>
 {directory && <div className="command-directory" title={directory}>工作目录：{directory}</div>}
 {command && <CommandText kind="命令" text={command} copy={commandCopy} />}<CommandText kind="输出" text={output} placeholder={placeholder} copy={outputCopy} />{notices}{raw}</div>;
}
