import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "../../lib/utils.js";

type StyledProps<T extends React.ElementType> = Omit<React.ComponentProps<T>, "className"> & {
  className?: string;
};

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: StyledProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      className={cn("group/tabs flex data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-overlay p-[3px] text-muted-foreground group-data-horizontal/tabs:h-control-lg group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
        strip: "h-full w-full justify-start gap-0 rounded-none bg-transparent p-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  activateOnFocus = true,
  ...props
}: StyledProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      activateOnFocus={activateOnFocus}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: StyledProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-control border border-transparent px-1.5 py-0.5 text-ui-base font-medium whitespace-nowrap text-foreground-subtle ui-control transition-colors group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:py-[calc(--spacing(1.25))] hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "group-data-[variant=strip]/tabs-list:h-full group-data-[variant=strip]/tabs-list:min-w-0 group-data-[variant=strip]/tabs-list:flex-1 group-data-[variant=strip]/tabs-list:justify-start group-data-[variant=strip]/tabs-list:gap-[calc(var(--spacing-inline)/2)] group-data-[variant=strip]/tabs-list:border-0 group-data-[variant=strip]/tabs-list:bg-transparent group-data-[variant=strip]/tabs-list:py-0 group-data-[variant=strip]/tabs-list:pl-[calc(var(--spacing-inline)*1.25)] group-data-[variant=strip]/tabs-list:pr-[calc(var(--spacing-control-xs)+var(--spacing-inline))] group-data-[variant=strip]/tabs-list:text-ui-caption group-data-[variant=strip]/tabs-list:text-inherit group-data-[variant=strip]/tabs-list:data-active:bg-transparent group-data-[variant=strip]/tabs-list:after:hidden",
        "data-active:bg-background data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: StyledProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-ui-base outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
