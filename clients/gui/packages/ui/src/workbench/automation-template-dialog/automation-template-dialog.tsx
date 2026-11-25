import type { ReactNode } from "react";
import { CalendarClock } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { Badge } from "../../components/badge/badge.js";
import { Callout } from "../../components/callout/callout.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/dialog/dialog.js";

export type AutomationTemplateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kindLabel?: string;
  title: string;
  scheduleSummary: string;
  prompt: string;
  hint?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  icon?: ReactNode;
};

/** 定时任务模板预览与确认弹窗（对标 Codex pluginTemplatePreview）：带滚动渐隐 Prompt 预览、调度摘要与影响提示。 */
export function AutomationTemplateDialog({
  open,
  onOpenChange,
  kindLabel = "定时任务",
  title,
  scheduleSummary,
  prompt,
  hint,
  confirmLabel = "使用此模板",
  cancelLabel = "取消",
  onConfirm,
  icon,
}: AutomationTemplateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="areal-automation-template-dialog"
        data-slot="automation-template-dialog"
      >
        <DialogHeader>
          <div className="areal-automation-template-eyebrow">
            <span className="areal-automation-template-icon" aria-hidden="true">
              {icon ?? <CalendarClock size={16} />}
            </span>
            <Badge tone="neutral" size="sm">
              {kindLabel}
            </Badge>
          </div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{scheduleSummary}</DialogDescription>
        </DialogHeader>
        {hint && <Callout tone="info">{hint}</Callout>}
        <div
          className="areal-automation-template-prompt scrollbar-on-hover"
          role="region"
          aria-label={title}
          tabIndex={0}
        >
          <pre>{prompt}</pre>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
