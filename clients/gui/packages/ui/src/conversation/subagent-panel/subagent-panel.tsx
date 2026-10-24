import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeftIcon, CircleAlertIcon, CircleCheckIcon, CircleDotIcon, XIcon } from "lucide-react";
import { Button } from "../../components/button/button.js";

type Subagent = { id: string; name: string; state: "running" | "completed" | "attention"; icon?: ReactNode; timeLabel?: string; statusLabel?: string };
export type SubagentPanelProps = {
  open: boolean;
  agents: readonly Subagent[];
  selectedId?: string;
  hasMore?: boolean;
  onSelect: (id: string | undefined) => void;
  onClose: () => void;
  children?: ReactNode;
};
const labels = { running: "运行中", completed: "已完成", attention: "需要确认" };
const icons = { running: CircleDotIcon, completed: CircleCheckIcon, attention: CircleAlertIcon };

/** Host-owned selection and history; list expansion and focus are reading state. */
export function SubagentPanel({ open, agents, selectedId, hasMore = false, onSelect, onClose, children }: SubagentPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef<string | undefined>(undefined);
  const selected = agents.find(agent => agent.id === selectedId);
  useLayoutEffect(() => {
    if (!open) return;
    if (selectedId) { previous.current = selectedId; heading.current?.focus({ preventScroll: true }); }
    else {
      const row = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-agent-id]") ?? [])].find(row => row.dataset.agentId === previous.current);
      (row ?? heading.current)?.focus({ preventScroll: true });
    }
  }, [open, selectedId]);
  return <section className="areal-subagent-panel" aria-label="子代理面板" hidden={!open}>
    <header className="areal-subagent-header">
      {selectedId && <Button variant="ghost" size="icon-sm" aria-label="返回子代理列表" onClick={() => onSelect(undefined)}><ArrowLeftIcon size={16} /></Button>}
      <h2 ref={heading} tabIndex={-1}>{selected ? <>{selected.icon}<span title={selected.name}>{selected.name}</span></> : selectedId ? "子代理" : "Subagents"}</h2>
      {selected && <span className="areal-subagent-state" data-state={selected.state}>{selected.statusLabel ?? labels[selected.state]}</span>}
      <Button variant="ghost" size="icon-sm" aria-label="关闭子代理面板" onClick={onClose}><XIcon size={16} /></Button>
    </header>
    <div ref={list} className="areal-subagent-list" hidden={!!selectedId}>
      {(["running", "attention", "completed"] as const).map(state => {
        const items = agents.filter(agent => agent.state === state);
        if (state === "attention" && !items.length) return null;
        const visible = state === "completed" && !expanded ? items.slice(0, 10) : items;
        const StatusIcon = icons[state];
        return <section key={state} aria-label={state === "running" ? "运行中子任务" : state === "completed" ? "已完成子任务" : "需要确认子任务"}>
          <h3>{state === "running" ? "Active" : state === "completed" ? "Done" : "Needs attention"} · {items.length}</h3>
          {!items.length && <p className="areal-subagent-empty">{state === "completed" ? (hasMore ? "已加载列表中没有已完成的子任务" : "还没有已完成的子任务") : (hasMore ? "已加载列表中没有运行中的子任务" : "没有运行中的子任务")}</p>}
          {visible.map(agent => <Button key={agent.id} data-agent-id={agent.id} variant="ghost" className="areal-subagent-row" onClick={() => onSelect(agent.id)}>
            {agent.icon}<span className="areal-subagent-name">{agent.name}</span><span className="areal-subagent-state" data-state={state}><StatusIcon size={14} />{agent.statusLabel ?? labels[state]}</span>{agent.timeLabel && <small>{agent.timeLabel}</small>}
          </Button>)}
          {state === "completed" && items.length > 10 && <Button variant="ghost" size="sm" className="areal-subagent-more" onClick={() => setExpanded(value => !value)}>{expanded ? "收起已完成子任务" : `显示另外 ${items.length - 10} 个已完成子任务`}</Button>}
        </section>;
      })}
    </div>
    {selectedId && <div className="areal-subagent-history" role="region" aria-label="子代理历史对话">{children}</div>}
  </section>;
}
