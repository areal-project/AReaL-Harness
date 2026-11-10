import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { DisclosureChevronIcon as ChevronRightIcon } from "../../icons.js";

import { cn } from "../../lib/utils.js";

type StyledProps<T extends React.ElementType> = Omit<React.ComponentProps<T>, "className"> & {
  className?: string;
};

function ContextMenu({ ...props }: StyledProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({ ...props }: StyledProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({
  className,
  side,
  align,
  sideOffset,
  ...props
}: StyledProps<typeof ContextMenuPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof ContextMenuPrimitive.Positioner>,
    "side" | "align" | "sideOffset"
  >) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="z-(--layer-popover) outline-none"
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "ui-popup flex flex-col gap-[calc(var(--spacing-inline)/4)] min-w-[calc(var(--reading-width)/6)] max-h-(--available-height) max-w-(--available-width) overflow-x-hidden overflow-y-auto rounded-overlay border-0 bg-menu p-[calc(var(--spacing-inline)/2)] text-foreground shadow-menu [backdrop-filter:var(--material-overlay-filter)] outline-none [app-region:no-drag]",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: StyledProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex min-h-control cursor-default items-center gap-inline rounded-inset px-inline py-[calc(var(--spacing-inline)/2)] text-ui-base/(--line-height-ui) text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-[calc(var(--icon-size-control)+var(--spacing-inline)*2)] data-[variant=destructive]:text-destructive data-[variant=destructive]:data-[highlighted]:bg-destructive data-[variant=destructive]:data-[highlighted]:text-destructive-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-size-control) data-[variant=destructive]:*:[svg]:text-current data-[variant=destructive]:data-[highlighted]:*:[svg]:text-destructive-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: StyledProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn(
        "-mx-[calc(var(--spacing-inline)/2)] my-[calc(var(--spacing-inline)/2)] h-(--border-width-default) bg-border",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSub({ ...props }: StyledProps<typeof ContextMenuPrimitive.SubmenuRoot>) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />;
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: StyledProps<typeof ContextMenuPrimitive.SubmenuTrigger> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "group/context-menu-sub-trigger flex min-h-control cursor-default items-center gap-inline rounded-inset px-inline py-[calc(var(--spacing-inline)/2)] text-ui-base/(--line-height-ui) text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-[calc(var(--icon-size-control)+var(--spacing-inline)*2)] data-popup-open:bg-menu-hover data-popup-open:text-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--icon-size-control)",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-(--icon-size-control) text-foreground-subtle group-data-[highlighted]/context-menu-sub-trigger:text-foreground-subtle" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

function ContextMenuSubContent(props: React.ComponentProps<typeof ContextMenuContent>) {
  return (
    <ContextMenuContent
      side="right"
      align="start"
      sideOffset={2}
      data-slot="context-menu-sub-content"
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
