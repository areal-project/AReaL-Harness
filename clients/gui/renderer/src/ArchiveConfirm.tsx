import { useCallback, useState } from "react";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import { useI18n } from "./i18n/IntlProvider.js";

/** 归档后会话不能再发送消息，先确认；桌面与网页同一份对话框。 */
export function useArchiveConfirm() {
  const { t } = useI18n();
  const [settle, setSettle] = useState<((confirmed: boolean) => void) | null>(null);
  const confirm = useCallback(
    () => new Promise<boolean>((resolve) => setSettle(() => resolve)),
    [],
  );
  const finish = (confirmed: boolean) => {
    settle?.(confirmed);
    setSettle(null);
  };
  const dialog = (
    <Dialog open={!!settle} onOpenChange={(open) => !open && finish(false)}>
      <DialogContent className="max-w-[min(calc(var(--reading-width)/2),calc(100%-var(--spacing-field)*2))]">
        <DialogHeader>
          <DialogTitle>{t("common.navigation.archiveQuestion")}</DialogTitle>
          <DialogDescription>{t("common.navigation.archiveDetail")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.navigation.cancel")}
          </DialogClose>
          <Button onClick={() => finish(true)}>{t("common.navigation.archiveConfirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { confirm, dialog };
}
