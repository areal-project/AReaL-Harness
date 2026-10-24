import type { ComponentProps, ReactNode } from "react";
import { Button } from "../../components/button/button.js";
import { cn } from "../../lib/utils.js";

/** Leading and trailing actions are supplied by the host. */
export function ComposerToolbar({ leading, trailing, className, ...props }: Omit<ComponentProps<"div">, "children"> & { leading: ReactNode; trailing: ReactNode }) {
  return <div {...props} className={cn("group/toolbar composer-toolbar", className)}>
    <div className="flex min-w-0 flex-1 items-center" data-composer-leading-actions>
      <div className="flex shrink-0 items-center gap-1" data-composer-leading-content>{leading}</div>
    </div>
    <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5" data-composer-trailing-actions>{trailing}</div>
  </div>;
}

// 输入区主动作（发送/继续）的外观属于对话组合，不进入基础 Button 的变体表。
// 发送、停止与禁用条件仍由宿主决定；这里只固定胶囊形与前景色反转。
const composerActionClasses = "composer-primary-action rounded-pill gap-1 bg-foreground text-ui-base text-background hover:bg-foreground/90 disabled:bg-secondary disabled:text-foreground-subtlest disabled:opacity-100";

/** Primary composer action (send/continue). Behavior stays with the host. */
export function ComposerActionButton({ className, size = "icon", ...props }: ComponentProps<typeof Button>) {
  return <Button {...props} size={size} className={cn(composerActionClasses, className)} />;
}
