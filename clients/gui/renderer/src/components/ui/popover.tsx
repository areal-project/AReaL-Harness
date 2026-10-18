"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "../lib/utils.js";

type StyledProps<T extends React.ElementType> = Omit<
  React.ComponentProps<T>,
  "className"
> & { className?: string };
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

function PopoverContent({
  className,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  anchor,
  variant = "default",
  ...props
}: StyledProps<typeof PopoverPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof PopoverPrimitive.Positioner>,
    "align" | "side" | "sideOffset" | "anchor"
  > & {
    variant?: "default" | "menu";
  }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        anchor={anchor}
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="z-(--layer-popover) outline-none"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "ui-popup flex w-72 max-w-(--available-width) max-h-(--available-height) flex-col gap-field rounded-overlay border border-popover-border text-ui-base text-popover-foreground shadow-overlay overflow-y-auto outline-none [app-region:no-drag]",
            variant === "menu" ? "bg-menu p-0" : "bg-popover p-2.5",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}
function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-ui-base", className)}
      {...props}
    />
  );
}
function PopoverTitle({
  className,
  ...props
}: StyledProps<typeof PopoverPrimitive.Title>) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("text-ui-base font-medium", className)}
      {...props}
    />
  );
}
function PopoverDescription({
  className,
  ...props
}: StyledProps<typeof PopoverPrimitive.Description>) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}
export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
