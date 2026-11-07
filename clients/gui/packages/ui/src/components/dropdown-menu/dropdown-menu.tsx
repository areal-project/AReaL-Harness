import * as React from "react";
import { Menu as DropdownMenuPrimitive } from "@base-ui/react/menu";
import {
  DisclosureChevronIcon as ChevronRightIcon,
  MenuSelectedIcon as CheckIcon,
} from "../../icons.js";

import { cn } from "../../lib/utils.js";

type StyledProps<T extends React.ElementType> = Omit<React.ComponentProps<T>, "className"> & {
  className?: string;
};

function DropdownMenu({ ...props }: StyledProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: StyledProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: StyledProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 2,
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof DropdownMenuPrimitive.Positioner>,
    "side" | "align" | "sideOffset"
  >) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="z-(--layer-popover) outline-none"
      >
        <DropdownMenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "ui-popup flex flex-col gap-[calc(var(--spacing-inline)/4)] min-w-[calc(var(--reading-width)/6)] max-h-(--available-height) max-w-(--available-width) overflow-x-hidden overflow-y-auto rounded-overlay border-0 bg-menu p-[calc(var(--spacing-inline)/2)] text-foreground shadow-menu [backdrop-filter:var(--material-overlay-filter)] outline-none [app-region:no-drag]",
            className,
          )}
          {...props}
        />
      </DropdownMenuPrimitive.Positioner>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({
  className,
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group
      data-slot="dropdown-menu-group"
      className={cn("flex flex-col gap-[calc(var(--spacing-inline)/4)]", className)}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex min-h-control cursor-default items-center gap-inline rounded-inset px-inline py-[calc(var(--spacing-inline)/2)] text-ui-base/(--line-height-ui) text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-[calc(var(--icon-size-control)+var(--spacing-inline)*2)] data-[variant=destructive]:text-destructive data-[variant=destructive]:data-[highlighted]:bg-destructive data-[variant=destructive]:data-[highlighted]:text-destructive-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-size-control) data-[variant=destructive]:*:[svg]:text-current data-[variant=destructive]:data-[highlighted]:*:[svg]:text-destructive-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex min-h-control cursor-default items-center gap-inline rounded-inset py-[calc(var(--spacing-inline)/2)] pr-[calc(var(--icon-size-control)+var(--spacing-inline)*2)] pl-inline text-ui-base/(--line-height-ui) text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-[calc(var(--icon-size-control)+var(--spacing-inline)*2)] data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-size-control)",
        className,
      )}
      closeOnClick
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-inline flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.CheckboxItemIndicator>
          <CheckIcon className="size-(--icon-size-control) text-foreground-subtle" />
        </DropdownMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  className,
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      className={cn("flex flex-col gap-[calc(var(--spacing-inline)/4)]", className)}
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.RadioItem> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      closeOnClick
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex min-h-control cursor-default items-center gap-inline rounded-inset py-[calc(var(--spacing-inline)/2)] pr-[calc(var(--icon-size-control)+var(--spacing-inline)*2)] pl-inline text-ui-base/(--line-height-ui) text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-[calc(var(--icon-size-control)+var(--spacing-inline)*2)] data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-size-control)",
        className,
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-inline flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.RadioItemIndicator>
          <CheckIcon className="size-(--icon-size-control) text-foreground-subtle" />
        </DropdownMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.GroupLabel> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-inline py-[calc(var(--spacing-inline)/2)] text-ui-base/(--line-height-ui) font-medium text-foreground-subtlest data-inset:pl-[calc(var(--icon-size-control)+var(--spacing-inline)*2)]",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(
        "-mx-[calc(var(--spacing-inline)/2)] my-[calc(var(--spacing-inline)/2)] h-(--border-width-default) bg-border",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-ui-xs tracking-widest text-foreground-subtlest group-data-[highlighted]/dropdown-menu-item:text-foreground-subtle",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: StyledProps<typeof DropdownMenuPrimitive.SubmenuRoot>) {
  return <DropdownMenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: StyledProps<typeof DropdownMenuPrimitive.SubmenuTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "group/dropdown-menu-sub-trigger flex min-h-control cursor-default items-center gap-inline rounded-inset px-inline py-[calc(var(--spacing-inline)/2)] text-ui-base/(--line-height-ui) text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-[calc(var(--icon-size-control)+var(--spacing-inline)*2)] data-popup-open:bg-menu-hover data-popup-open:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-size-control)",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-(--icon-size-control) text-foreground-subtle group-data-[highlighted]/dropdown-menu-sub-trigger:text-foreground-subtle" />
    </DropdownMenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent(props: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      side="right"
      align="start"
      sideOffset={2}
      data-slot="dropdown-menu-sub-content"
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
