import type { ReactNode } from "react";
import { Button } from "../button/button.js";
import { Callout } from "../callout/callout.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../dialog/dialog.js";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 清晰描述即将发生的动作与对象。 */
  title: ReactNode;
  /** 补充上下文说明。 */
  description?: ReactNode;
  /** 不可逆后果提示块（可选，自动按 tone 渲染为 Callout）。 */
  impact?: ReactNode;
  /** 必须写“动词 + 具体结果”（如“移除工作树”），禁止孤立“确定”。 */
  confirmLabel: string;
  /** 必须写明安全退路（如“保留”或“继续编辑”）。 */
  cancelLabel: string;
  /** 语义强度：高危不可逆用 destructive，中断/覆写用 warning。 */
  tone?: "default" | "destructive" | "warning";
  /** 提交中状态：禁用重复点击并标注 aria-busy，等待真实结果。 */
  pending?: boolean;
  /** 可选自定义提交中文案。 */
  pendingLabel?: string;
  onConfirm: () => void;
  closeLabel?: string;
};

/** 不可逆高危操作的阻断确认弹窗；可逆操作应优先直接执行并提供撤销（Undo）。 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  impact,
  confirmLabel,
  cancelLabel,
  tone = "default",
  pending = false,
  pendingLabel,
  onConfirm,
  closeLabel,
}: ConfirmDialogProps) {
  const calloutTone = tone === "destructive" ? "danger" : tone === "warning" ? "warning" : "info";
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        data-slot="confirm-dialog"
        data-tone={tone}
        aria-busy={pending || undefined}
        showCloseButton={!pending}
        closeLabel={closeLabel ?? cancelLabel}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {impact && <Callout tone={calloutTone}>{impact}</Callout>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button type="button" variant={tone} disabled={pending} onClick={onConfirm}>
            {pending && pendingLabel ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
