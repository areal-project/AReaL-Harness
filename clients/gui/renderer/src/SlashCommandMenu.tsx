import { useLayoutEffect, useRef, useState } from "react";
import type { AppSlashCommand } from "./slashCommandHelpers.js";
import "./slash-command-menu.css";

/** Input suggestions only; execution and editor focus belong to the caller. */
export function SlashCommandMenu({ id, rows, index, query, anchor, onSelect, onChoose }: {
  id: string;
  rows: readonly AppSlashCommand[];
  index: number;
  query: string;
  anchor: HTMLElement;
  onSelect: (index: number) => void;
  onChoose: (command: AppSlashCommand) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(320);
  const [edges, setEdges] = useState({ above: false, below: false });
  const updateEdges = () => {
    const el = scroll.current;
    if (el) setEdges({ above: el.scrollTop > 1, below: el.scrollTop + el.clientHeight < el.scrollHeight - 1 });
  };
  useLayoutEffect(() => {
    // The portal grows upward; its bottom remains anchored to the composer.
    const resize = () => setHeight(Math.max(0, Math.min(320, anchor.getBoundingClientRect().bottom - 8 - 12)));
    resize();
    const observer = new ResizeObserver(resize);
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [anchor]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = 0;
  }, [query]);
  useLayoutEffect(() => {
    const el = scroll.current;
    const row = el?.children[index];
    if (el && row instanceof HTMLElement) {
      const top = row.offsetTop;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + row.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + row.offsetHeight - el.clientHeight;
    }
    updateEdges();
  }, [index, rows.length, query, height]);
  return <div id={id} role="listbox" aria-label="命令" className="slash-command-menu" style={{ maxHeight: height }}>
    <div ref={scroll} className="slash-command-scroll" data-above={edges.above} data-below={edges.below} onScroll={updateEdges}>
      {rows.length ? rows.map((command, i) => <button id={`${id}-${i}`} key={command.value} type="button" role="option"
        aria-selected={i === index} tabIndex={-1} className="slash-command-row"
        onMouseDown={event => event.preventDefault()} onMouseMove={() => onSelect(i)} onClick={() => onChoose(command)}>
        <span className="slash-command-icon" aria-hidden="true">{command.icon}</span>
        <span className="slash-command-label">{command.label}</span>{" "}
        <span className="slash-command-description">{command.description}</span>
      </button>) : <div className="slash-command-empty">无命令</div>}
    </div>
  </div>;
}
