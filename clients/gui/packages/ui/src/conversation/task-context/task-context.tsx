import {
  useId,
  useState,
  type ComponentProps,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ArrowLeftIcon, PlusIcon, NetworkIcon } from "lucide-react";
import { Button } from "../../components/button/button.js";

export type TaskContextProps = {
  title: string;
  id?: string;
  hidden?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  headingRef?: Ref<HTMLHeadingElement>;
  actions?: ReactNode;
  onBack?: () => void;
  /** Inside a popover that already draws the frame. */
  embedded?: boolean;
  children: ReactNode;
};
function TaskContextRoot({
  title,
  id,
  hidden,
  onKeyDown,
  headingRef,
  actions,
  onBack,
  embedded = false,
  children,
}: TaskContextProps) {
  return (
    <aside
      id={id}
      hidden={hidden}
      onKeyDown={onKeyDown}
      className="areal-task-context"
      data-embedded={embedded || undefined}
      aria-label="任务上下文"
    >
      <header className="areal-context-top">
        <h2 ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        {actions}
      </header>
      {onBack && (
        <Button variant="ghost" size="sm" className="areal-context-back" onClick={onBack}>
          <ArrowLeftIcon size={14} />
          返回任务上下文
        </Button>
      )}
      <div className="areal-context-body">{children}</div>
    </aside>
  );
}
function ContextSection({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="areal-context-section" aria-label={label}>
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}
type ContextItemProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "className" | "variant" | "size" | "title" | "unstyled"
> & {
  title: string;
  description?: string;
  tooltip?: string;
  icon?: ReactNode;
  meta?: ReactNode;
};
function ContextItem({ title, description, tooltip, icon, meta, ...props }: ContextItemProps) {
  return (
    <Button
      {...props}
      aria-label={
        props["aria-label"]
          ? [title, description, typeof meta === "string" ? meta : undefined].reduce<string>(
              (label, text) => (text && !label.includes(text) ? `${label} ${text}` : label),
              props["aria-label"],
            )
          : undefined
      }
      title={tooltip ?? title}
      variant="ghost"
      className="areal-context-item"
    >
      {icon && <span className="areal-context-item-icon">{icon}</span>}
      <span className="areal-context-item-body">
        <span>{title}</span>
        {description && <small>{description}</small>}
      </span>
      {meta && <span className="areal-context-item-meta">{meta}</span>}
    </Button>
  );
}
type ContextSourcesProps<T> = {
  items: readonly T[];
  children: (item: T) => ReactNode;
  onViewAll: () => void;
  onAdd?: () => void;
  collapseLabel?: string;
  expandLabel?: string;
  title?: string;
};
function ContextSources<T extends { id: string }>({
  items,
  children,
  onViewAll,
  onAdd,
  collapseLabel = "收起",
  expandLabel = "展开",
  title = "来源",
}: ContextSourcesProps<T>) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <ContextSection label="输入来源">
      <Collapsible.Root className="areal-context-sources" open={open} onOpenChange={setOpen}>
        <div className="areal-sources-heading">
          <Collapsible.Trigger
            render={<Button variant="ghost" className="areal-sources-trigger" />}
            aria-label={`${title} ${open ? collapseLabel : expandLabel}`}
            aria-controls={id}
          >
            <span>{title}</span>
            <span className="areal-sources-toggle-label">{open ? collapseLabel : expandLabel}</span>
          </Collapsible.Trigger>
          {onAdd && (
            <Button variant="ghost" size="icon-sm" aria-label="添加来源" onClick={onAdd}>
              <PlusIcon size={16} />
            </Button>
          )}
        </div>
        <Collapsible.Panel id={id} keepMounted>
          {items.length ? (
            items.slice(0, 3).map((item) => <div key={item.id}>{children(item)}</div>)
          ) : (
            <p className="areal-context-empty">还没有输入来源</p>
          )}
          {items.length > 3 && (
            <Button
              variant="ghost"
              size="sm"
              className="areal-sources-view-all"
              onClick={onViewAll}
              aria-label={`查看全部来源（${items.length}）`}
            >
              <NetworkIcon size={16} />
              查看全部
            </Button>
          )}
        </Collapsible.Panel>
      </Collapsible.Root>
    </ContextSection>
  );
}

/** Layout and reading controls. Navigation, resource authority and focus return stay with the host. */
export const TaskContext = Object.assign(TaskContextRoot, {
  Section: ContextSection,
  Item: ContextItem,
  Sources: ContextSources,
});
