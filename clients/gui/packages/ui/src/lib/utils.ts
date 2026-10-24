import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const mergeUiClasses = extendTailwindMerge({
  extend: {
    classGroups: {
      // 控件尺寸也是 size-*；让调用方的紧凑尺寸替换默认值，避免两类同时命中。
      size: [{ size: ["control", "control-xs", "control-sm", "control-lg"] }],
      // text-ui-* 是字号而不是 text color；显式注册，避免和 text-foreground 等颜色类互相覆盖。
      "font-size": [
        "text-ui-xl",
        "text-ui-lg",
        "text-ui-base",
        "text-ui-caption",
        "text-ui-sm",
        "text-ui-xs",
        "text-mobile-input-safe",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeUiClasses(clsx(inputs));
}
