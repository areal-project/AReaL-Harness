import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../../lib/utils.js";

function Switch({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, "className"> & { className?: string } & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      nativeButton
      render={<button type="button" />}
      data-slot="switch"
      data-size={size}
      className={cn(
        "p-px peer group/switch relative inline-flex shrink-0 items-center rounded-full ui-control transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-input-border-focused/30 aria-invalid:ring-2 aria-invalid:ring-destructive/20 data-[size=default]:p-[calc(var(--spacing-inline)/4)] data-[size=default]:h-(--line-height-ui) data-[size=default]:w-(--spacing-control-lg) data-[size=sm]:h-[16px] data-[size=sm]:w-[28px] dark:aria-invalid:ring-destructive/40 data-[checked]:bg-brand data-[unchecked]:bg-foreground/10 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-(--opacity-disabled)",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-control-thumb ring-0 ui-control transition-transform group-data-[size=default]/switch:size-(--icon-size-control) group-data-[size=sm]/switch:size-3.5 group-data-[size=default]/switch:data-[checked]:translate-x-[calc(var(--spacing-control-lg)-var(--icon-size-control)-var(--spacing-inline)/2)] group-data-[size=sm]/switch:data-[checked]:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-[unchecked]:translate-x-0 group-data-[size=sm]/switch:data-[unchecked]:translate-x-0"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
