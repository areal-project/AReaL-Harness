import { useEffect, useRef, useState, type ReactNode } from "react";
import { CopiedIcon, MessageCopy } from "./interfaceIcons.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";

/** Copy the original Core text, including Markdown, rather than DOM decorations. */
export function CopyTextAction({ text, noun = "消息", className = "", iconSize = 16 }: {
  text: string; noun?: string; className?: string; iconSize?: number;
}) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    ++request.current;
    setResult(null);
    clearTimeout(timer.current);
    return () => { ++request.current; clearTimeout(timer.current); };
  }, [text]);
  const copy = async () => {
    const attempt = ++request.current;
    clearTimeout(timer.current);
    setResult(null);
    try {
      await navigator.clipboard.writeText(text);
      if (attempt !== request.current) return;
      setResult("copied");
      timer.current = setTimeout(() => {
        if (attempt === request.current) setResult(null);
      }, 2000);
    } catch {
      if (attempt === request.current) setResult("failed");
    }
  };
  const label = result === "copied" ? `已复制${noun}` : `复制${noun}`;
  const hint = result === "failed" ? "复制失败，请重试" : label;
  return <>
    <ControlHintTooltip title={hint}>
      <button className={`icon-button ${className}`} type="button" aria-label={label} onClick={() => void copy()}>
        {result === "copied" ? <CopiedIcon size={iconSize} /> : <MessageCopy size={iconSize} />}
      </button>
    </ControlHintTooltip>
    {result && <span className="sr-only" role="status">{result === "failed" ? "复制失败，请选择文本手动复制" : `${noun}已复制`}</span>}
  </>;
}

export function MessageActions({ text, noun = "消息", children }: { text: string; noun?: string; children?: ReactNode }) {
  return <div className="message-actions">
    <CopyTextAction text={text} noun={noun} iconSize={14} />
    {children}
  </div>;
}
