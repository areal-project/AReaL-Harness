import { TitleTooltip } from "../../components/tooltip/tooltip.js";
import { useState, type ReactNode } from "react";
export type CommandDetailsLabels = {
  expandCommand?: string;
  collapseCommand?: string;
  commandRegion?: string;
  outputRegion?: string;
  directoryPrefix?: string;
};

function CommandText({
  text,
  kind,
  placeholder,
  copy,
  labels,
}: {
  text: string;
  kind: "command" | "output";
  placeholder?: string;
  copy?: ReactNode;
  labels?: CommandDetailsLabels;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="command-text">
      {kind === "command" ? (
        <button
          type="button"
          className="command-input-toggle"
          aria-label={`${expanded ? (labels?.collapseCommand ?? "收起完整命令") : (labels?.expandCommand ?? "展开完整命令")} $ ${text}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <pre
            className={expanded ? "command-input" : "command-input command-input-clamped"}
            aria-label={labels?.commandRegion ?? "执行命令"}
          >
            $ {text}
          </pre>
        </button>
      ) : (
        <pre
          className="command-output"
          tabIndex={0}
          aria-label={labels?.outputRegion ?? "工具结果"}
        >
          {text || placeholder}
        </pre>
      )}
      {copy}
    </div>
  );
}

export function CommandDetails({
  heading,
  status,
  failed,
  directory,
  command,
  output,
  placeholder,
  commandCopy,
  outputCopy,
  metadata,
  notices,
  raw,
  labels,
}: {
  heading: string;
  status: string;
  failed?: boolean;
  directory?: string;
  command?: string;
  output: string;
  placeholder: string;
  commandCopy?: ReactNode;
  outputCopy?: ReactNode;
  metadata?: ReactNode;
  notices?: ReactNode;
  raw: ReactNode;
  labels?: CommandDetailsLabels;
}) {
  return (
    <div className="tool-event-body command-card">
      <div className="tool-event-heading command-heading">
        <span>{heading}</span>
        <span role="status" className={failed ? "command-outcome tool-failed" : "command-outcome"}>
          {status}
        </span>
        {metadata}
      </div>
      {directory && (
        <TitleTooltip title={directory}>
          <div className="command-directory">
            {labels?.directoryPrefix ?? "工作目录："}
            {directory}
          </div>
        </TitleTooltip>
      )}
      {command && <CommandText kind="command" text={command} copy={commandCopy} labels={labels} />}
      <CommandText
        kind="output"
        text={output}
        placeholder={placeholder}
        copy={outputCopy}
        labels={labels}
      />
      {notices}
      {raw}
    </div>
  );
}
