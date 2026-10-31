import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
function Root({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("scheduled-workspace", className)} />;
}
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section role="group" aria-label={label} className="scheduled-group">
      <h2>{label}</h2>
      {children}
    </section>
  );
}
function Item({
  title,
  description,
  className,
  ...props
}: Omit<ComponentProps<"button">, "title"> & { title: string; description: string }) {
  return (
    <button
      type="button"
      {...props}
      className={cn("scheduled-item", className)}
      title={`${title} · ${description}`}
    >
      <span>{title}</span>
      <small>{description}</small>
    </button>
  );
}
function Welcome({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="scheduled-welcome">
      <div className="scheduled-intro">
        <span>{icon}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="scheduled-templates">{children}</div>
    </main>
  );
}
function Template({
  icon,
  title,
  description,
  ...props
}: Omit<ComponentProps<"button">, "title"> & {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button type="button" {...props} className="scheduled-template">
      <span>{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}
type TaskState = "enabled" | "running" | "paused" | "attention" | "finished" | "deleted";
function Status({
  state,
  label,
  className,
}: {
  state: TaskState;
  label: string;
  className?: string;
}) {
  return (
    <span role="status" className={cn("scheduled-status", className)} data-state={state}>
      {label}
    </span>
  );
}
/** 会话卡片与右侧面板共用的一行任务：图标、名称、摘要、状态和操作槽。 */
function TaskRow({
  icon,
  title,
  summary,
  state,
  stateLabel,
  actions,
  variant = "card",
  onOpen,
  openLabel,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  icon: ReactNode;
  title: string;
  summary: string;
  state: TaskState;
  stateLabel: string;
  actions?: ReactNode;
  variant?: "card" | "compact";
  onOpen?: () => void;
  openLabel?: string;
}) {
  const body = (
    <>
      <span className="scheduled-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="scheduled-row-text">
        <span className="scheduled-row-title">{title}</span>
        <small>{summary}</small>
      </span>
    </>
  );
  return (
    <div
      {...props}
      className={cn("scheduled-row", className)}
      data-variant={variant}
      data-state={state}
    >
      {onOpen ? (
        <button
          type="button"
          className="scheduled-row-main"
          aria-description={openLabel}
          title={`${title} · ${summary}`}
          onClick={onOpen}
        >
          {body}
        </button>
      ) : (
        <div className="scheduled-row-main" title={`${title} · ${summary}`}>
          {body}
        </div>
      )}
      {(variant === "card" || state !== "enabled") && <Status state={state} label={stateLabel} />}
      {actions && <span className="scheduled-row-actions">{actions}</span>}
    </div>
  );
}
export const ScheduledWorkspace = Object.assign(Root, {
  Group,
  Item,
  Welcome,
  Template,
  TaskRow,
  Status,
});
