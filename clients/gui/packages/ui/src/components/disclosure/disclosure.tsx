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
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Reading state only. Execution state and attention content belong to the caller. */
export function Disclosure({
  label,
  displayLabel,
  children,
  icon,
  indicator,
  keepMounted = false,
  className,
  textRole = "content",
  presentation = "collapsible",
  open: controlledOpen,
  onOpenChange,
}: DisclosureProps) {
  const [localOpen, setOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const id = useId();
  return (
    <Collapsible.Root
      open={presentation === "inline" || open}
      onOpenChange={(next) => {
        if (controlledOpen === undefined) setOpen(next);
        onOpenChange?.(next);
      }}
      className={cn("areal-disclosure", className)}
      data-text-role={textRole}
      data-presentation={presentation}
    >
      <Collapsible.Trigger
        render={<Button variant="ghost" className="areal-disclosure-trigger" />}
        aria-controls={id}
        aria-label={label}
      >
        {icon}
        <span>{displayLabel ?? label}</span>
        <span className="areal-disclosure-indicator">
          {indicator ?? <ChevronRightIcon size={14} />}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel id={id} keepMounted={keepMounted} className="areal-disclosure-panel">
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
