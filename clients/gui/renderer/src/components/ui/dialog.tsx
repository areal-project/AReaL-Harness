import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "../lib/utils.js";
import { Button } from "./button.js";
import { CloseIcon as XIcon } from "../../interfaceIcons.js";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Backdrop>, "className"> & { className?: string }) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        // Linux 旧标题栏避让让模态遮罩从 48px 以下开始，窗口顶部仍保持高亮且 tooltip 可见。
        // renderer 自绘窗控位于同一窗口，模态态应与其它平台一致覆盖完整视口。
        "fixed inset-0 isolate z-(--layer-dialog) bg-black/60 duration-(--motion-normal) supports-backdrop-filter:backdrop-blur-xs transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

// 圆角规范迁移：默认外壳统一 2xl，三个截图/附件预览入口显式保留 xl，内容层级独立计算。
function DialogContent({
  className,
  children,
  showCloseButton = true,
  showOverlay = true,
  overlayClassName,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Popup>, "className"> & {
  className?: string;
  showCloseButton?: boolean;
  showOverlay?: boolean;
  overlayClassName?: string;
}) {
  return (
    <DialogPortal>
      {showOverlay ? <DialogOverlay className={overlayClassName} /> : null}
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // Electron 自绘标题栏下，弹窗可能会落进窗口顶部的 drag 区域。
          // 如果不把弹窗内容整体标成 no-drag，右上角关闭按钮这类交互会被窗口拖拽命中吞掉。
          "fixed top-1/2 left-1/2 z-(--layer-dialog) grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-field rounded-dialog border border-popover-border bg-popover p-panel text-ui-base/relaxed text-foreground shadow-dialog duration-(--motion-normal) outline-none ui-popup data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 [app-region:no-drag]",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button
              type="button"
              variant="ghost"
              className="absolute top-4 right-4 z-20 hover:bg-surface-hover [app-region:no-drag]"
              size="icon-sm"
            />}
          >
            <XIcon />
            <span className="sr-only">关闭弹窗</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>关闭</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: Omit<React.ComponentProps<typeof DialogPrimitive.Title>, "className"> & { className?: string }) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-ui-base font-medium text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Description>, "className"> & { className?: string }) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-ui-base/relaxed text-foreground-subtle *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
