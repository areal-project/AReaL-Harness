import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "../../lib/utils.js";
import { Button } from "../button/button.js";
import { CloseIcon as XIcon } from "../../icons.js";

function Sheet({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

export type SheetContentProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Popup>,
  "className"
> & {
  className?: string;
  /** 抽屉滑出方向：桌面默认右侧，窄视口可用底部。 */
  side?: "right" | "left" | "bottom";
  /** 抽屉宽度档位（仅左右方向生效）。 */
  size?: "sm" | "md" | "lg";
  showCloseButton?: boolean;
  showOverlay?: boolean;
  closeLabel?: string;
};

/** 保留主任务上下文的边缘抽屉容器，基于 Base UI Dialog 保障键盘、焦点与 Esc 关闭。 */
function SheetContent({
  className,
  children,
  side = "right",
  size = "md",
  showCloseButton = true,
  showOverlay = true,
  closeLabel = "Close panel",
  ...props
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal data-slot="sheet-portal">
      {showOverlay ? (
        <DialogPrimitive.Backdrop data-slot="sheet-overlay" className="areal-sheet-overlay" />
      ) : null}
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        data-size={size}
        className={cn("areal-sheet-content", className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button type="button" variant="ghost" className="areal-sheet-close" size="icon-sm" />
            }
          >
            <XIcon />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sheet-header" className={cn("areal-sheet-header", className)} {...props} />
  );
}

function SheetTitle({
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Title>, "className"> & { className?: string }) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("areal-sheet-title", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Description>, "className"> & {
  className?: string;
}) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("areal-sheet-description", className)}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-body" className={cn("areal-sheet-body", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sheet-footer" className={cn("areal-sheet-footer", className)} {...props} />
  );
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
