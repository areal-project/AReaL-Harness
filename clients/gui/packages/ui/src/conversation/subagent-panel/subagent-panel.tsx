import { TitleTooltip } from "../../components/tooltip/tooltip.js";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../../components/button/button.js";

type Subagent = {
  id: string;
  name: string;
  state: "running" | "completed" | "attention";
  icon?: ReactNode;
  timeLabel?: string;
  statusLabel?: string;
};
export type SubagentPanelLabels = {
  panel?: string;
  back?: string;
  close?: string;
  title?: string;
  fallbackTitle?: string;
  historyRegion?: string;
  states?: Record<"running" | "completed" | "attention", string>;
  sectionTitles?: Record<"running" | "completed" | "attention", string>;
  sectionRegions?: Record<"running" | "completed" | "attention", string>;
  emptyCompleted?: string;
  emptyCompletedLoaded?: string;
  emptyRunning?: string;
  emptyRunningLoaded?: string;
  collapseCompleted?: string;
  showMoreCompleted?: (count: number) => string;
};

export type SubagentPanelProps = {
  open: boolean;
  agents: readonly Subagent[];
  selectedId?: string;
  hasMore?: boolean;
  onSelect: (id: string | undefined) => void;
  onClose: () => void;
  /** Inside a reader pane: no divider, and the history child owns its own insets. */
  embedded?: boolean;
  labels?: SubagentPanelLabels;
  children?: ReactNode;
};
const defaultStateLabels = { running: "运行中", completed: "已完成", attention: "需要确认" };
const defaultSectionTitles = { running: "Active", completed: "Done", attention: "Needs attention" };
const defaultSectionRegions = {
  running: "运行中子任务",
  completed: "已完成子任务",
  attention: "需要确认子任务",
};
const icons = { running: CircleDotIcon, completed: CircleCheckIcon, attention: CircleAlertIcon };

/** Host-owned selection and history; list expansion and focus are reading state. */
export function SubagentPanel({
  open,
  agents,
  selectedId,
  hasMore = false,
  onSelect,
  onClose,
  embedded = false,
  labels,
  children,
}: SubagentPanelProps) {
  const stateLabels = labels?.states ?? defaultStateLabels;
  const sectionTitles = labels?.sectionTitles ?? defaultSectionTitles;
  const sectionRegions = labels?.sectionRegions ?? defaultSectionRegions;
  const [expanded, setExpanded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef<string | undefined>(undefined);
  const selected = agents.find((agent) => agent.id === selectedId);
  useLayoutEffect(() => {
    if (!open) return;
    if (selectedId) {
      previous.current = selectedId;
      heading.current?.focus({ preventScroll: true });
    } else {
      const row = [
        ...(list.current?.querySelectorAll<HTMLButtonElement>("[data-agent-id]") ?? []),
      ].find((row) => row.dataset.agentId === previous.current);
      (row ?? heading.current)?.focus({ preventScroll: true });
    }
  }, [open, selectedId]);
  return (
    <section
      className="areal-subagent-panel"
      aria-label={labels?.panel ?? "子代理面板"}
      hidden={!open}
      data-embedded={embedded || undefined}
    >
      <header className="areal-subagent-header">
        {selectedId && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={labels?.back ?? "返回子代理列表"}
            onClick={() => onSelect(undefined)}
          >
            <ArrowLeftIcon size={16} />
          </Button>
        )}
        <h2 ref={heading} tabIndex={-1}>
          {selected ? (
            <>
              {selected.icon}
              <TitleTooltip title={selected.name}>
                <span>{selected.name}</span>
              </TitleTooltip>
            </>
          ) : selectedId ? (
            (labels?.fallbackTitle ?? "子代理")
          ) : (
            (labels?.title ?? "Subagents")
          )}
        </h2>
        {selected && (
          <span className="areal-subagent-state" data-state={selected.state}>
            {selected.statusLabel ?? stateLabels[selected.state]}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={labels?.close ?? "关闭子代理面板"}
          onClick={onClose}
        >
          <XIcon size={16} />
        </Button>
      </header>
      <div ref={list} className="areal-subagent-list" hidden={!!selectedId}>
        {(["running", "attention", "completed"] as const).map((state) => {
          const items = agents.filter((agent) => agent.state === state);
          if (state === "attention" && !items.length) return null;
          const visible = state === "completed" && !expanded ? items.slice(0, 10) : items;
          const StatusIcon = icons[state];
          return (
            <section key={state} aria-label={sectionRegions[state]}>
              <h3>
                {sectionTitles[state]} · {items.length}
              </h3>
              {!items.length && (
                <p className="areal-subagent-empty">
                  {state === "completed"
                    ? hasMore
                      ? (labels?.emptyCompletedLoaded ?? "已加载列表中没有已完成的子任务")
                      : (labels?.emptyCompleted ?? "还没有已完成的子任务")
                    : hasMore
                      ? (labels?.emptyRunningLoaded ?? "已加载列表中没有运行中的子任务")
                      : (labels?.emptyRunning ?? "没有运行中的子任务")}
                </p>
              )}
              {visible.map((agent) => (
                <Button
                  key={agent.id}
                  data-agent-id={agent.id}
                  variant="ghost"
                  className="areal-subagent-row"
                  onClick={() => onSelect(agent.id)}
                >
                  {agent.icon}
                  <span className="areal-subagent-name">{agent.name}</span>
                  <span className="areal-subagent-state" data-state={state}>
                    <StatusIcon size={14} />
                    {agent.statusLabel ?? stateLabels[state]}
                  </span>
                  {agent.timeLabel && <small>{agent.timeLabel}</small>}
                </Button>
              ))}
              {state === "completed" && items.length > 10 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="areal-subagent-more"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded
                    ? (labels?.collapseCompleted ?? "收起已完成子任务")
                    : labels?.showMoreCompleted
                      ? labels.showMoreCompleted(items.length - 10)
                      : `显示另外 ${items.length - 10} 个已完成子任务`}
                </Button>
              )}
            </section>
          );
        })}
      </div>
      {selectedId && (
        <div
          className="areal-subagent-history"
          role="region"
          aria-label={labels?.historyRegion ?? "子代理历史对话"}
        >
          {children}
        </div>
      )}
    </section>
  );
}
