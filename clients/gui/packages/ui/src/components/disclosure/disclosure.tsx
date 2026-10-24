import { useId, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "../button/button.js";
import { cn } from "../../lib/utils.js";

export type DisclosureProps = {
  label: string;
  presentation?: "collapsible" | "inline";
  displayLabel?: string;
  children: ReactNode;
  icon?: ReactNode;
  indicator?: ReactNode;
  keepMounted?: boolean;
  className?: string;
  textRole?: "content" | "interface";
};

/** Reading state only. Execution state and attention content belong to the caller. */
export function Disclosure({ label, displayLabel, children, icon, indicator, keepMounted = false, className, textRole = "content", presentation = "collapsible" }: DisclosureProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <Collapsible.Root open={presentation === "inline" || open} onOpenChange={setOpen} className={cn("areal-disclosure", className)} data-text-role={textRole} data-presentation={presentation}>
    <Collapsible.Trigger render={<Button variant="ghost" className="areal-disclosure-trigger" />} aria-controls={id} aria-label={label}>
      {icon}<span>{displayLabel ?? label}</span><span className="areal-disclosure-indicator">{indicator ?? <ChevronRightIcon size={14} />}</span>
    </Collapsible.Trigger>
    <Collapsible.Panel id={id} keepMounted={keepMounted} className="areal-disclosure-panel">{children}</Collapsible.Panel>
  </Collapsible.Root>;
}
