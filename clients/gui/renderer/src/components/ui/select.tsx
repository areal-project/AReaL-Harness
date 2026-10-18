"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.js";
import { ChevronDownIcon, CheckIcon } from "lucide-react";

type StyledProps<T extends React.ElementType> = Omit<React.ComponentProps<T>, "className"> & { className?: string };

// resize 大会话时 Select trigger 跟随基础控件批量重排，
// transition-all 会把布局/滚动条相关属性也动画化；这里限定为颜色过渡。
const selectTriggerVariants = cva(
  "ui-control flex w-fit items-center justify-between gap-1.5 border whitespace-nowrap transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 data-placeholder:text-foreground-subtlest *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        input:
          "border-input-border bg-input text-foreground hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0",
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-transparent text-foreground hover:bg-input/50 hover:text-foreground aria-expanded:bg-selected aria-expanded:text-foreground",
        secondary:
          "border-transparent bg-secondary text-foreground hover:bg-secondary-hover aria-expanded:bg-secondary aria-expanded:text-foreground",
        ghost:
          "border-transparent bg-transparent text-foreground hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 aria-expanded:bg-destructive aria-expanded:text-destructive-foreground",
      },
      size: {
        xs: "h-control-xs rounded-sm pl-2 pr-1 text-ui-base [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-control-sm rounded-control pl-2 pr-1 text-ui-base/relaxed [&_svg:not([class*='size-'])]:size-3",
        default:
          "h-control rounded-control pl-2 pr-1 text-ui-base/relaxed [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-control-lg rounded-overlay pl-3 pr-2 text-ui-base [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "input",
      size: "default",
    },
  },
);

const Select = SelectPrimitive.Root;

function SelectGroup({ className, ...props }: StyledProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("flex flex-col gap-0.5 scroll-my-1 p-1", className)}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: StyledProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" className={cn("min-w-0 truncate", className)} {...props} />;
}

function SelectTrigger({
  className,
  variant = "input",
  size = "default",
  children,
  indicator,
  ...props
}: StyledProps<typeof SelectPrimitive.Trigger> &
  VariantProps<typeof selectTriggerVariants> & {
    indicator?: React.ReactNode;
  }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant}
      data-size={size}
      className={cn(selectTriggerVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        {indicator ?? (
          <ChevronDownIcon className="pointer-events-none size-3.5 text-foreground-subtle" />
        )}
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** Popup placement and layering belong to the component, never the consumer. */
function SelectContent({
  className, children, align = "start", alignItemWithTrigger = false, ...props
}: StyledProps<typeof SelectPrimitive.Popup> & Pick<React.ComponentProps<typeof SelectPrimitive.Positioner>, "align" | "alignItemWithTrigger">) {
  return <SelectPrimitive.Portal>
    <SelectPrimitive.Positioner align={align} alignItemWithTrigger={alignItemWithTrigger} sideOffset={4} className="z-(--layer-popover) outline-none">
      <SelectPrimitive.Popup data-slot="select-content" className={cn(
        "ui-popup min-w-(--anchor-width) max-w-(--available-width) overflow-hidden rounded-overlay border border-popover-border bg-menu p-1 text-foreground shadow-overlay outline-none [app-region:no-drag]", className,
      )} {...props}>
        <SelectPrimitive.List className="flex max-h-(--available-height) flex-col gap-0.5 overflow-y-auto outline-none">{children}</SelectPrimitive.List>
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  </SelectPrimitive.Portal>;
}

function SelectLabel({ className, ...props }: StyledProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-ui-base text-foreground-subtlest", className)}
      {...props}
    />
  );
}

type SelectItemProps = StyledProps<typeof SelectPrimitive.Item> & {
  trailing?: React.ReactNode;
};

const SelectItem = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Item>, SelectItemProps>(
  ({ className, children, trailing, ...props }, ref) => {
    return (
      <SelectPrimitive.Item
        ref={ref}
        data-slot="select-item"
        className={cn(
          "relative flex min-h-control w-full cursor-default items-center gap-2 rounded-control px-2 py-1 text-ui-base/relaxed text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:text-foreground-subtlest data-[disabled]:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
          className,
        )}
        {...props}
      >
        {trailing ? (
          <span className="pointer-events-auto absolute right-2 flex items-center justify-center">
            {trailing}
          </span>
        ) : null}
        <span className="pointer-events-none absolute right-2 flex items-center justify-center">
          <SelectPrimitive.ItemIndicator>
            <CheckIcon className="pointer-events-none size-4 text-foreground-subtle" />
          </SelectPrimitive.ItemIndicator>
        </span>
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </SelectPrimitive.Item>
    );
  },
);

SelectItem.displayName = "SelectItem";

function SelectSeparator({
  className,
  ...props
}: StyledProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
};
