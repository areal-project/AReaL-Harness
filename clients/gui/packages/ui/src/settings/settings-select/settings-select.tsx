import { Children, isValidElement, Fragment, type ReactNode, type ReactElement } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/select/select.js";
import { SettingsSegmentedTabs } from "../settings-segmented-tabs/settings-segmented-tabs.js";
import { Switch } from "../../components/switch/switch.js";
import { Button } from "../../components/button/button.js";


export function SettingsLockedValue({ label, value }: { label: string; value: string }) {
  return (
    <button type="button" className="settings-locked-value" aria-label={label} disabled>
      <span>{value}</span>
    </button>
  );
}

export function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-surface px-2.5 py-1 text-ui-base font-medium text-foreground-subtle">
      {children}
    </span>
  );
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
    />
  );
}

export function SettingsValueAction({
  value,
  actionLabel,
  onAction,
  disabled = false,
}: {
  value: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-3">
      <span className="min-w-0 text-ui-sm text-foreground-subtle max-w-[280px] truncate">{value}</span>
      {onAction && (
        <Button type="button" variant="secondary" onClick={onAction} disabled={disabled}>
          {actionLabel ?? "Change"}
        </Button>
      )}
    </div>
  );
}

/** Settings values use a segmented pair or the shared menu, never a native select. */
export function SettingsSelect({ children, value, onValueChange, disabled, className, placeholder = "Select an option", emptyLabel = "No options available", "aria-label": label }: {
  children: ReactNode; value: string | number; onValueChange: (value: string) => void;
  disabled?: boolean; className?: string; placeholder?: string; emptyLabel?: string; "aria-label": string;
}) {
  const text = (nodes: ReactNode): string => Children.toArray(nodes).map(node =>
    isValidElement(node) ? text((node.props as {children?: ReactNode}).children) : String(node),
  ).join("");
  const options: {value: string; label: string; disabled?: boolean}[] = [];
  const collect = (nodes: ReactNode) => Children.forEach(nodes, node => {
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{value?: string | number; children?: ReactNode; disabled?: boolean}>;
    if (element.type === Fragment) collect(element.props.children);
    else if (element.type === "option") options.push({value: String(element.props.value ?? text(element.props.children)), label: text(element.props.children), disabled: element.props.disabled});
  });
  collect(children);
  if (options.length === 2) return <SettingsSegmentedTabs ariaLabel={label} activateOnFocus={false}
    disabled={disabled} value={String(value)} onValueChange={onValueChange} items={options} />;
  return <Select value={String(value)} items={options} onValueChange={next => { if (next !== null) onValueChange(next); }} disabled={disabled}>
    <SelectTrigger aria-label={label} variant="secondary" size="sm" className={className}><SelectValue placeholder={options.length ? placeholder : emptyLabel} /></SelectTrigger>
    <SelectContent align="end">{options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}
