import type { ComponentProps } from "react";
import { cva } from "class-variance-authority";
import { Button } from "../../components/button/button.js";
import { DialogContent } from "../../components/dialog/dialog.js";
import { cn } from "../../lib/utils.js";

// 移动端触控形态集中在包内：页面只传布局类，触控尺寸、字号与行外观由 kind 决定。
const mobileButtonKinds = cva("min-h-(--size-touch-target)", {
  variants: {
    kind: {
      touch: "min-w-(--size-touch-target)",
      icon: "size-(--size-touch-target)",
      inline: "min-w-(--size-touch-target) gap-0 px-0 text-fixed-control",
      chip: "mobile-composer-chip h-auto min-w-0 max-w-full shrink gap-[calc(var(--spacing-inline)/2)] px-inline py-[calc(var(--spacing-inline)/2)] text-fixed-caption text-foreground-subtle [&_span]:min-w-0 [&_span]:truncate [&_svg]:size-[var(--activity-chevron-size)]!",
      primary:
        "composer-primary-action min-w-(--size-touch-target) [border-radius:var(--radius-pill)]",
      stop: "composer-primary-action composer-stop-action min-w-(--size-touch-target) [border-radius:var(--radius-pill)]",
      "sheet-cancel": "text-fixed-control",
      "sheet-done":
        "mobile-sheet-done h-(--size-touch-target) min-w-(--size-touch-target) font-semibold text-fixed-body",
      summary:
        "mobile-model-summary h-auto w-full justify-center gap-inline text-fixed-section-title! [&>span]:min-w-0",
      "setting-row":
        "mobile-setting-row flex h-auto w-full justify-start gap-inline p-field text-fixed-emphasis! [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border [&_svg]:size-[var(--spacing-field)]!",
      "project-card":
        "mobile-project-card h-auto w-full justify-start gap-inline whitespace-normal rounded-none! border-b border-border p-field text-start text-foreground shadow-none",
      "work-row":
        "mobile-work-row h-auto w-full min-w-(--size-touch-target) justify-start gap-inline whitespace-normal p-inline text-start shadow-none [border-radius:var(--radius-navigation)]! hover:bg-navigation-selected focus-visible:bg-navigation-selected active:bg-navigation-selected",
    },
  },
  defaultVariants: { kind: "touch" },
});

type MobileButtonKind = NonNullable<Parameters<typeof mobileButtonKinds>[0]>["kind"];

export function MobileButton({
  kind = "touch",
  className,
  ...props
}: ComponentProps<typeof Button> & { kind?: MobileButtonKind }) {
  return <Button {...props} className={cn(mobileButtonKinds({ kind }), className)} />;
}

/** 移动端底部面板：沿纵轴进出、无阴影描边，标题行高由面板统一决定。 */
export function MobileSheetContent({ className, ...props }: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      {...props}
      className={cn("mobile-model-sheet mobile-sheet-content border-0 shadow-none", className)}
    />
  );
}
