import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Button as ButtonPrimitive } from "@base-ui/react/button";

import { cn } from "../../lib/utils.js";
import { TitleTooltip } from "../tooltip/tooltip.js";

// 大会话窗口 resize trace 显示基础按钮的 transition-all 会批量启动
// scrollbar-color/尺寸等非合成动画，放大主线程 style/layout 压力；只过渡颜色和合成层的 scale。
// 按下缩放给出即时反馈；菜单触发器跳过，避免与弹出的菜单同时变形。
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center rounded-button border border-transparent bg-clip-padding text-ui-caption/(--line-height-relaxed) whitespace-nowrap ui-control transition-[color,background-color,border-color,box-shadow,scale] [&:active:not([aria-haspopup])]:scale-[0.97] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 select-none disabled:pointer-events-none disabled:opacity-(--opacity-disabled) aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border text-foreground hover:border-border-hover hover:bg-input/50 hover:text-foreground aria-expanded:bg-input/50 aria-expanded:text-foreground",
        surface:
          "border-border bg-surface text-foreground hover:border-border-hover hover:bg-hover aria-expanded:bg-hover",
        "destructive-subtle":
          "bg-destructive/5 text-destructive hover:bg-destructive/10 focus-visible:ring-destructive/30",
        secondary:
          "bg-button-surface text-foreground hover:bg-button-hover aria-expanded:bg-button-hover aria-expanded:text-foreground",
        ghost:
          "text-foreground hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        "ghost-subtle":
          "text-foreground-subtle hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground aria-pressed:bg-selected aria-pressed:text-foreground",
        floating:
          "rounded-pill border-border bg-background text-foreground shadow-subtle backdrop-blur-sm hover:bg-hover",
        "inline-link":
          "h-auto min-h-0 border-0 bg-transparent p-0 text-inherit hover:bg-transparent hover:text-foreground hover:underline",
        row: "w-full justify-start border-0 bg-transparent text-left text-foreground hover:bg-hover aria-current:bg-selected",
        "media-trigger":
          "block h-auto min-h-0 cursor-zoom-in overflow-hidden rounded-xl border-border bg-surface p-0 hover:border-border-hover",
        "media-overlay":
          "bg-media-overlay/65 text-media-overlay-foreground hover:bg-media-overlay/80",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 aria-expanded:bg-destructive aria-expanded:text-destructive-foreground",
        warning:
          "bg-warning text-warning-foreground hover:bg-warning/90 focus-visible:border-warning/40 focus-visible:ring-warning/20 aria-expanded:bg-warning aria-expanded:text-warning-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-control gap-1 px-2 text-ui-caption has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-control-xs gap-1 rounded-sm px-2 text-ui-caption has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-control-sm gap-1 px-2 text-ui-caption/(--line-height-relaxed) has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-control-lg gap-1 rounded-button px-2.5 text-ui-caption has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        chip: "h-control-xs gap-1 rounded-pill px-2 text-ui-caption [&_svg:not([class*='size-'])]:size-3.5",
        auto: "h-auto min-h-0 gap-inline px-2 py-1.5 text-ui-caption whitespace-normal text-start",
        rail: "size-(--rail-button-size) rounded-navigation [&_svg:not([class*='size-'])]:size-(--icon-size-rail)",
        icon: "size-control [&_svg:not([class*='size-'])]:size-4",
        "icon-xs": "size-control-xs rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-control-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-control-lg rounded-button [&_svg:not([class*='size-'])]:size-4",
        none: "h-auto min-h-0 p-0",
      },
      shape: {
        default: "",
        pill: "rounded-pill",
      },
      align: {
        center: "justify-center",
        start: "justify-start text-start",
      },
      active: {
        false: "",
        true: "bg-selected text-foreground",
      },
      wrap: {
        false: "",
        true: "h-auto whitespace-normal text-start",
      },
      revealOnGroupHover: {
        false: "",
        true: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      shape: "default",
      align: "center",
      active: false,
      wrap: false,
      revealOnGroupHover: false,
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  shape = "default",
  align = "center",
  active = false,
  wrap = false,
  revealOnGroupHover = false,
  unstyled = false,
  title,
  ...props
}: Omit<React.ComponentProps<typeof ButtonPrimitive>, "className"> &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    /** Retain Base UI behavior when an existing composition owns all appearance. */
    unstyled?: boolean;
  }) {
  const button = (
    <ButtonPrimitive
      data-slot="button"
      data-variant={unstyled ? undefined : variant}
      data-size={unstyled ? undefined : size}
      data-active={active || undefined}
      className={
        unstyled
          ? className
          : cn(
              buttonVariants({
                variant,
                size,
                shape,
                align,
                active,
                wrap,
                revealOnGroupHover,
                className,
              }),
            )
      }
      {...props}
    />
  );
  // 原生 title 的延迟、外观和位置都与应用提示不同；title 统一渲染为共享提示。
  return <TitleTooltip title={title}>{button}</TitleTooltip>;
}

export { Button, buttonVariants };
